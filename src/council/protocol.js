// Jalannya sidang: FRAME → ronde 1 (blind) → JUDGE → ronde kritik + suara → … → (suara akhir) → selesai.
// Lihat docs/PLAN.md §5. Engine tidak mencetak apa pun; semua kejadian dikirim lewat emit(event).

import { isReached, tally } from './consensus.js'
import { MODERATOR_SYSTEM, PANELIST_SYSTEM, framePrompt, judgePrompt, panelPrompt, repairPrompt, votePrompt } from './prompts.js'
import { extractJson, validateFrame, validateJudge, validatePanelist, validateVoteOnly } from './schema.js'

// Minta jawaban JSON; kalau tidak valid, minta perbaikan satu kali (tanpa web search, hanya merapikan format).
export async function askJson(agent, { system, prompt, model, webSearch = false }, validate) {
  const calls = []
  async function call(text, web) {
    const start = Date.now()
    try {
      const res = await agent.ask({ system, prompt: text, model, webSearch: web })
      calls.push({ agent: agent.id, ms: Date.now() - start, costUsd: res.costUsd, tokens: res.usage?.total_tokens, model: res.meta?.model })
      return res
    } catch (err) {
      calls.push({ agent: agent.id, ms: Date.now() - start, failed: true })
      err.calls = calls
      throw err
    }
  }
  const first = await call(prompt, webSearch)
  try {
    return { value: validate(extractJson(first.text)), calls, repaired: false }
  } catch (err) {
    const second = await call(repairPrompt({ prompt, previous: first.text, error: err.message }), false)
    try {
      return { value: validate(extractJson(second.text)), calls, repaired: true }
    } catch (err2) {
      const failure = new Error(`jawaban tidak valid, juga setelah diminta perbaikan: ${err2.message}`)
      failure.calls = calls
      throw failure
    }
  }
}

export async function runCouncil({
  topic,
  panel,
  moderator,
  maxRounds = 3,
  consensus = 'unanimous',
  web = true,
  emit = () => {},
  clock = () => new Date(),
  finalize
}) {
  const send = (event) => emit({ ts: clock().toISOString(), ...event })
  const labelOf = Object.fromEntries(panel.map((a) => [a.id, a.label]))
  const panelIds = panel.map((a) => a.id)
  const usage = { calls: 0, failedCalls: 0, ms: 0, costUsd: 0, tokens: 0 }
  const track = (calls = []) => {
    for (const c of calls) {
      usage.calls++
      if (c.failed) usage.failedCalls++
      usage.ms += c.ms
      if (typeof c.costUsd === 'number') usage.costUsd += c.costUsd
      if (typeof c.tokens === 'number') usage.tokens += c.tokens
    }
  }
  const startedAt = clock()
  const moderatorInfo = { id: moderator.agent.id, label: moderator.agent.label, model: moderator.model || moderator.agent.model || null }
  send({
    type: 'session_started',
    topic,
    panel: panel.map((a) => ({ id: a.id, label: a.label, model: a.model || null })),
    moderator: moderatorInfo,
    maxRounds,
    consensus,
    web
  })

  const askModerator = async (prompt, validate) => {
    try {
      const r = await askJson(moderator.agent, { system: MODERATOR_SYSTEM, prompt, model: moderator.model || undefined }, validate)
      track(r.calls)
      return r.value
    } catch (err) {
      track(err.calls)
      throw err
    }
  }

  // FRAME
  let frame
  try {
    frame = await askModerator(framePrompt(topic), validateFrame)
  } catch (err) {
    frame = { question: topic, criteria: [], context: '' }
    send({ type: 'warning', stage: 'frame', message: `Moderator gagal merumuskan pertanyaan (${err.message}); topik dipakai apa adanya.` })
  }
  send({ type: 'framed', ...frame })

  async function runPanel(round, mode, { draft, focus, previous }) {
    send({ type: 'round_started', round, mode })
    const entries = await Promise.all(
      panel.map(async (agent) => {
        send({ type: 'agent_started', round, agent: agent.id })
        const start = Date.now()
        const others = Object.entries(previous || {})
          .filter(([id]) => id !== agent.id)
          .map(([id, response]) => ({ label: labelOf[id], response }))
        const useWeb = web && mode !== 'vote' && agent.capabilities?.webSearch === true
        const prompt =
          mode === 'vote'
            ? votePrompt({ frame, draft })
            : panelPrompt({ frame, round, draft, focus, own: previous?.[agent.id], others, webSearch: useWeb })
        const validate = mode === 'vote' ? validateVoteOnly : (obj) => validatePanelist(obj, { expectVote: mode === 'critique' })
        try {
          const r = await askJson(agent, { system: PANELIST_SYSTEM, prompt, webSearch: useWeb }, validate)
          track(r.calls)
          const ms = Date.now() - start
          send({ type: 'agent_finished', round, agent: agent.id, ms, repaired: r.repaired, response: r.value })
          return [agent.id, { ok: true, ms, repaired: r.repaired, response: r.value }]
        } catch (err) {
          track(err.calls)
          const ms = Date.now() - start
          send({ type: 'agent_failed', round, agent: agent.id, ms, error: err.message })
          return [agent.id, { ok: false, ms, error: err.message }]
        }
      })
    )
    return Object.fromEntries(entries)
  }

  const rounds = []
  let draft = null
  let judged = null
  let previous = null // jawaban sukses ronde sebelumnya, per id
  let status = null
  let decided = null // { round, draftRound, votes, tally }

  for (let round = 1; round <= maxRounds; round++) {
    const mode = round === 1 ? 'blind' : 'critique'
    const results = await runPanel(round, mode, { draft, focus: judged?.next_focus, previous })
    const entry = { round, mode, results }
    rounds.push(entry)

    if (mode === 'critique') {
      const votes = Object.fromEntries(panelIds.map((id) => [id, results[id].response?.vote]))
      const t = tally(panelIds, votes)
      entry.votes = votes
      entry.tally = t
      send({ type: 'votes', round, draftRound: round - 1, ...t, votes })
      if (isReached(t.status, consensus)) {
        status = t.status
        decided = { round, draftRound: round - 1, votes, tally: t }
        break
      }
    }

    const ok = panel.filter((a) => results[a.id].ok)
    if (!ok.length) {
      status = 'error'
      send({ type: 'warning', stage: 'panel', round, message: 'Semua panelis gagal menjawab di ronde ini; sidang dihentikan.' })
      break
    }

    try {
      judged = await askModerator(
        judgePrompt({
          frame,
          round,
          previousDraft: draft,
          responses: ok.map((a) => ({ label: a.label, response: results[a.id].response })),
          failed: panel.filter((a) => !results[a.id].ok).map((a) => ({ label: a.label }))
        }),
        validateJudge
      )
      draft = judged.draft
      entry.judged = judged
      send({ type: 'judged', round, ...judged })
    } catch (err) {
      send({ type: 'warning', stage: 'judge', round, message: `Moderator gagal merangkum ronde ${round} (${err.message}).` })
      if (!draft) {
        status = 'error'
        break
      }
    }
    previous = Object.fromEntries(ok.map((a) => [a.id, results[a.id].response]))
  }

  if (!status) {
    // Batas ronde habis tanpa konsensus: suara akhir atas draft terakhir.
    const round = rounds.length + 1
    const results = await runPanel(round, 'vote', { draft })
    const votes = Object.fromEntries(panelIds.map((id) => [id, results[id].response?.vote]))
    const t = tally(panelIds, votes)
    rounds.push({ round, mode: 'vote', results, votes, tally: t })
    send({ type: 'votes', round, draftRound: round - 1, final: true, ...t, votes })
    status = t.status
    decided = { round, draftRound: round - 1, votes, tally: t }
  }

  const finalJudged = decided ? rounds.find((r) => r.round === decided.draftRound)?.judged || judged : judged
  const result = {
    topic,
    frame,
    status,
    consensus,
    maxRounds,
    web,
    panel: panel.map((a) => ({ id: a.id, label: a.label, model: a.model || null })),
    moderator: moderatorInfo,
    rounds,
    decided,
    final: finalJudged ? { ...finalJudged } : null,
    usage,
    startedAt: startedAt.toISOString(),
    finishedAt: clock().toISOString()
  }
  const extra = finalize ? await finalize(result) : {}
  send({
    type: 'finished',
    status,
    round: decided?.round ?? rounds.length,
    summary: result.final?.summary || '',
    draft: result.final?.draft || '',
    usage,
    ...extra
  })
  return result
}
