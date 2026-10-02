// Jalannya sidang: FRAME → ronde 1 (blind) → VERIFY → JUDGE → ronde kritik + suara → … → (suara akhir) → selesai.
// Lihat docs/PLAN.md §5. Engine tidak mencetak apa pun; semua kejadian dikirim lewat emit(event).

import { EMPTY_TOKENS, addTokens } from '../agents/usage.js'
import { aliasOrder, assignAliases } from './anonymize.js'
import { ClaimRegistry, countByStatus } from './claims.js'
import { accepts, isReached, tally } from './consensus.js'
import { MODERATOR_SYSTEM, PANELIST_SYSTEM, framePrompt, judgePrompt, panelPrompt, repairPrompt, votePrompt } from './prompts.js'
import { extractJson, validateFrame, validateJudge, validatePanelist, validateVoteOnly } from './schema.js'

// Minta jawaban JSON; kalau tidak valid, minta perbaikan satu kali (tanpa web search, hanya merapikan format).
// effort/repairEffort hanya dipakai agen yang mendukungnya (Claude Code CLI); agen lain mengabaikannya.
export async function askJson(agent, { system, prompt, model, webSearch = false, effort, repairEffort }, validate) {
  const calls = []
  async function call(text, web, repair) {
    const start = Date.now()
    try {
      const res = await agent.ask({ system, prompt: text, model, webSearch: web, effort: (repair ? repairEffort : effort) || undefined })
      calls.push({ agent: agent.id, repair, ms: Date.now() - start, costUsd: res.costUsd, tokens: res.tokens || null, model: res.meta?.model })
      return res
    } catch (err) {
      calls.push({ agent: agent.id, repair, ms: Date.now() - start, failed: true })
      err.calls = calls
      throw err
    }
  }
  const first = await call(prompt, webSearch, false)
  try {
    return { value: validate(extractJson(first.text)), calls, repaired: false }
  } catch (err) {
    const second = await call(repairPrompt({ prompt, previous: first.text, error: err.message }), false, true)
    try {
      return { value: validate(extractJson(second.text)), calls, repaired: true }
    } catch (err2) {
      const failure = new Error(`jawaban tidak valid, juga setelah diminta perbaikan: ${err2.message}`)
      failure.calls = calls
      throw failure
    }
  }
}

function createUsage() {
  const blank = () => ({ calls: 0, failedCalls: 0, ms: 0, costUsd: 0, tokens: { ...EMPTY_TOKENS }, measured: 0 })
  const usage = { ...blank(), byRole: {}, byStage: {} }
  function track(calls = [], { role, stage }) {
    const sum = blank()
    for (const c of calls) {
      for (const bucket of [usage, sum, (usage.byRole[role] ||= blank()), (usage.byStage[c.repair ? 'repair' : stage] ||= blank())]) {
        bucket.calls++
        if (c.failed) bucket.failedCalls++
        bucket.ms += c.ms
        if (typeof c.costUsd === 'number') bucket.costUsd += c.costUsd
        if (c.tokens) {
          bucket.tokens = addTokens(bucket.tokens, c.tokens)
          bucket.measured++
        }
      }
    }
    return sum
  }
  return { usage, track }
}

export async function runCouncil({
  topic,
  panel,
  moderator,
  maxRounds = 3,
  consensus = 'unanimous',
  web = true,
  searchBudget = 3,
  devilsAdvocate = true,
  effort = {},
  verify = null,
  random = Math.random,
  emit = () => {},
  clock = () => new Date(),
  finalize
}) {
  const send = (event) => emit({ ts: clock().toISOString(), ...event })
  const panelIds = panel.map((a) => a.id)
  const aliases = assignAliases(panelIds, random)
  const aliasOf = (id) => aliases[id] || id
  const registry = new ClaimRegistry()
  const { usage, track } = createUsage()
  const flags = []
  const startedAt = clock()
  const moderatorInfo = { id: moderator.agent.id, label: moderator.agent.label, model: moderator.model || moderator.agent.model || null }
  send({
    type: 'session_started',
    topic,
    panel: panel.map((a) => ({ id: a.id, label: a.label, model: a.model || null, alias: aliases[a.id] })),
    moderator: moderatorInfo,
    maxRounds,
    consensus,
    web,
    verify: Boolean(verify)
  })

  const askModerator = async (prompt, validate, stage) => {
    try {
      const r = await askJson(moderator.agent, { system: MODERATOR_SYSTEM, prompt, model: moderator.model || undefined, effort: effort[stage], repairEffort: effort.repair }, validate)
      track(r.calls, { role: 'moderator', stage })
      return r.value
    } catch (err) {
      track(err.calls, { role: 'moderator', stage })
      throw err
    }
  }

  // FRAME
  let frame
  try {
    frame = await askModerator(framePrompt(topic), validateFrame, 'frame')
  } catch (err) {
    frame = { question: topic, criteria: [], context: '' }
    send({ type: 'warning', stage: 'frame', message: `Moderator gagal merumuskan pertanyaan (${err.message}); topik dipakai apa adanya.` })
  }
  send({ type: 'framed', ...frame })

  // Klaim jawaban panelis dimasukkan ke daftar klaim bersama dan diberi ID global (K1, K2, …).
  function register(agentId, round, response) {
    const claims = response.claims.map((c) => {
      const entry = registry.add(c, { agent: agentId, round })
      return { id: entry.id, text: entry.text, kind: entry.kind, source_url: entry.source_url, quote: entry.quote }
    })
    const unknown = response.cited_claims.filter((id) => !registry.has(id))
    if (unknown.length) flags.push({ type: 'unknown_citation', agent: agentId, round, detail: unknown.join(', ') })
    return { ...response, claims, cited_claims: response.cited_claims.filter((id) => registry.has(id)) }
  }

  async function runVerification(round) {
    if (!verify) return
    const pending = registry.pending()
    if (!pending.length) return
    try {
      const results = await verify(pending)
      registry.setVerification(results)
      send({
        type: 'verified',
        round,
        total: pending.length,
        counts: countByStatus(pending),
        claims: pending.map((c) => ({ id: c.id, status: c.verification?.status, detail: c.verification?.detail, source_url: c.source_url }))
      })
    } catch (err) {
      send({ type: 'warning', stage: 'verify', round, message: `Verifikasi sumber gagal (${err.message}).` })
    }
  }

  async function runPanel(round, mode, { draft, focus, previous, previousVotes, devil }) {
    send({ type: 'round_started', round, mode, ...(devil ? { devilsAdvocate: devil } : {}) })
    const entries = await Promise.all(
      panel.map(async (agent) => {
        send({ type: 'agent_started', round, agent: agent.id })
        const start = Date.now()
        const others = Object.entries(previous || {})
          .filter(([id]) => id !== agent.id)
          .map(([id, response]) => ({ label: aliasOf(id), response }))
        const useWeb = web && mode !== 'vote' && agent.capabilities?.webSearch === true
        const claims = registry.list()
        const prompt =
          mode === 'vote'
            ? votePrompt({ frame, draft, alias: aliasOf(agent.id), previousVote: previousVotes?.[agent.id], claims, aliasOf })
            : panelPrompt({
                frame,
                round,
                alias: aliasOf(agent.id),
                draft,
                focus,
                own: previous?.[agent.id],
                others,
                claims,
                aliasOf,
                webSearch: useWeb,
                searchBudget,
                devilsAdvocate: devil === agent.id
              })
        const validate = mode === 'vote' ? validateVoteOnly : (obj) => validatePanelist(obj, { expectVote: mode === 'critique' })
        try {
          const stage = mode === 'vote' ? 'vote' : 'panel'
          const r = await askJson(agent, { system: PANELIST_SYSTEM, prompt, webSearch: useWeb, effort: effort[stage], repairEffort: effort.repair }, validate)
          const spent = track(r.calls, { role: agent.id, stage })
          const response = mode === 'vote' ? r.value : register(agent.id, round, r.value)
          const ms = Date.now() - start
          send({ type: 'agent_finished', round, agent: agent.id, ms, repaired: r.repaired, usage: { calls: spent.calls, tokens: spent.tokens, costUsd: spent.costUsd }, response })
          return [agent.id, { ok: true, ms, repaired: r.repaired, response }]
        } catch (err) {
          track(err.calls, { role: agent.id, stage: mode === 'vote' ? 'vote' : 'panel' })
          const ms = Date.now() - start
          send({ type: 'agent_failed', round, agent: agent.id, ms, error: err.message })
          return [agent.id, { ok: false, ms, error: err.message }]
        }
      })
    )
    return Object.fromEntries(entries)
  }

  // Catatan integritas: suara yang saling bertentangan atau berubah tanpa penjelasan.
  function checkIntegrity(round, results, previousVotes) {
    const found = []
    for (const id of panelIds) {
      const res = results[id]?.response
      if (!res) continue
      const vote = res.vote
      if (res.changed_mind?.changed && !res.changed_mind.because) found.push({ type: 'change_without_reason', agent: id, round })
      if (!vote) continue
      if (vote.on_draft !== 'DISAGREE' && vote.blocking_objections.length) found.push({ type: 'contradictory_vote', agent: id, round })
      const before = previousVotes?.[id]
      if (before && accepts(before) !== accepts(vote)) {
        const explained = Boolean(vote.change_reason || (res.changed_mind?.changed && res.changed_mind.because))
        if (!explained) found.push({ type: 'unexplained_flip', agent: id, round, detail: `${before.on_draft} → ${vote.on_draft}` })
      }
    }
    if (found.length) {
      flags.push(...found)
      send({ type: 'flags', round, flags: found })
    }
  }

  const order = aliasOrder(aliases)
  const devilFor = (round) => (devilsAdvocate && round > 1 && panel.length > 1 ? order[(round - 2) % order.length] : null)

  const rounds = []
  let draft = null
  let judged = null
  let previous = null // jawaban sukses ronde sebelumnya, per id
  let previousVotes = null
  let status = null
  let decided = null // { round, draftRound, votes, tally }

  for (let round = 1; round <= maxRounds; round++) {
    const mode = round === 1 ? 'blind' : 'critique'
    const devil = devilFor(round)
    const results = await runPanel(round, mode, { draft, focus: judged?.next_focus, previous, devil })
    const entry = { round, mode, results, ...(devil ? { devilsAdvocate: devil } : {}) }
    rounds.push(entry)
    await runVerification(round)

    if (mode === 'critique') {
      const votes = Object.fromEntries(panelIds.map((id) => [id, results[id].response?.vote]))
      checkIntegrity(round, results, previousVotes)
      const t = tally(panelIds, votes)
      entry.votes = votes
      entry.tally = t
      send({ type: 'votes', round, draftRound: round - 1, ...t, votes })
      previousVotes = votes
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
          responses: ok.map((a) => ({ label: aliasOf(a.id), response: results[a.id].response })),
          failed: panel.filter((a) => !results[a.id].ok).map((a) => ({ label: aliasOf(a.id) })),
          claims: registry.list(),
          aliasOf
        }),
        validateJudge,
        'judge'
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
    const results = await runPanel(round, 'vote', { draft, previousVotes })
    const votes = Object.fromEntries(panelIds.map((id) => [id, results[id].response?.vote]))
    checkIntegrity(round, results, previousVotes)
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
    verify: Boolean(verify),
    panel: panel.map((a) => ({ id: a.id, label: a.label, model: a.model || null, alias: aliases[a.id] })),
    moderator: moderatorInfo,
    aliases,
    rounds,
    decided,
    final: finalJudged ? { ...finalJudged } : null,
    claims: registry.list(),
    flags,
    usage,
    startedAt: startedAt.toISOString(),
    finishedAt: clock().toISOString()
  }
  const extra = finalize ? await finalize(result) : {}
  send({
    type: 'finished',
    status,
    round: decided?.round ?? rounds.length,
    // "vote" = diputuskan di pemungutan suara akhir, "critique" = sepakat di ronde kritik.
    decidedBy: decided ? rounds.find((r) => r.round === decided.round)?.mode : null,
    summary: result.final?.summary || '',
    draft: result.final?.draft || '',
    verification: countByStatus(registry.list()),
    flags: flags.length,
    usage,
    ...extra
  })
  return result
}
