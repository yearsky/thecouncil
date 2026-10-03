// Jalannya sidang: FRAME → [RISET: literatur + peneliti → VERIFY] → ronde 1 (blind) → VERIFY → JUDGE →
// ronde kritik + suara → … → (suara akhir) → selesai. Lihat docs/PLAN.md §5 dan §19.
// Engine tidak mencetak apa pun; semua kejadian dikirim lewat emit(event).

import { EMPTY_TOKENS, addTokens } from '../agents/usage.js'
import { aliasOrder, assignAliases } from './anonymize.js'
import { ClaimRegistry, countByStatus } from './claims.js'
import { accepts, isReached, tally } from './consensus.js'
import { judgeClaim, matchQuote, normalizeUrl } from '../evidence/verify.js'
import { paperText } from '../evidence/scholar.js'
import { memoryBlock } from './memory.js'
import {
  LENSES,
  MODERATOR_SYSTEM,
  PANELIST_SYSTEM,
  RESEARCHER_SYSTEM,
  framePrompt,
  judgePrompt,
  literatureBlock,
  panelPrompt,
  repairPrompt,
  researchBlock,
  researchPrompt,
  votePrompt
} from './prompts.js'
import { extractJson, validateFrame, validateJudge, validatePanelist, validateResearch, validateVoteOnly } from './schema.js'

// Sinyal "jeda" dari runner cloud (src/cloud/runner.js): sidang dilanjutkan di pemanggilan fungsi berikutnya.
// Bukan kegagalan, jadi tidak boleh dicatat sebagai agen gagal atau peringatan.
export const isYield = (err) => Boolean(err?.isYield)

// Minta jawaban JSON; kalau tidak valid, minta perbaikan satu kali (tanpa web search, hanya merapikan format).
// effort/repairEffort hanya dipakai agen yang mendukungnya (Claude Code CLI); agen lain mengabaikannya.
// elapsedMs dari jawaban (jurnal cloud) dipakai kalau ada, supaya durasi asli tidak hilang saat diputar ulang.
// searchUses: batas pencarian untuk panggilan ini (agen API); tanpa itu agen memakai batas bawaannya.
export async function askJson(agent, { system, prompt, model, webSearch = false, searchUses, effort, repairEffort }, validate) {
  const calls = []
  async function call(text, web, repair) {
    const start = Date.now()
    try {
      const res = await agent.ask({ system, prompt: text, model, webSearch: web, ...(web && searchUses ? { searchUses } : {}), effort: (repair ? repairEffort : effort) || undefined })
      const meta = res.meta || {}
      calls.push({
        agent: agent.id,
        repair,
        ms: res.elapsedMs ?? Date.now() - start,
        costUsd: res.costUsd,
        tokens: res.tokens || null,
        model: meta.model,
        ...(meta.stopReason === 'max_tokens' ? { truncated: true } : {}),
        ...(web ? { web: true, searches: meta.webSearchRequests || 0, searchUrls: (meta.searchUrls || []).slice(0, 30) } : {}),
        ...(meta.searchFallback ? { searchFallback: meta.searchFallback } : {})
      })
      return res
    } catch (err) {
      if (isYield(err)) throw err
      calls.push({ agent: agent.id, repair, ms: err.elapsedMs ?? Date.now() - start, failed: true })
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

// Penulis klaim yang berasal dari memori sidang sebelumnya dan dari tahap riset.
export const MEMORY_AGENT = 'memori'
export const RESEARCH_AGENT = 'peneliti'

// Ringkasan pencarian web dari panggilan satu agen: berapa kali mencari dan halaman apa yang muncul.
// null kalau agen tidak diberi web search. Angka 0 berarti model memilih tidak mencari.
export function searchSummary(calls = []) {
  const web = calls.filter((c) => c.web)
  if (!web.length) return null
  const urls = [...new Set(web.flatMap((c) => c.searchUrls || []))]
  const fallback = web.find((c) => c.searchFallback)?.searchFallback
  return { requests: web.reduce((n, c) => n + (c.searches || 0), 0), urls: urls.slice(0, 20), results: urls.length, ...(fallback ? { fallback } : {}) }
}

function createUsage() {
  const blank = () => ({ calls: 0, failedCalls: 0, ms: 0, costUsd: 0, searches: 0, tokens: { ...EMPTY_TOKENS }, measured: 0 })
  const usage = { ...blank(), byRole: {}, byStage: {} }
  function track(calls = [], { role, stage }) {
    const sum = blank()
    for (const c of calls) {
      for (const bucket of [usage, sum, (usage.byRole[role] ||= blank()), (usage.byStage[c.repair ? 'repair' : stage] ||= blank())]) {
        bucket.calls++
        if (c.failed) bucket.failedCalls++
        if (c.truncated) bucket.truncated = (bucket.truncated || 0) + 1
        bucket.ms += c.ms
        bucket.searches += c.searches || 0
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
  lenses = false,
  research = null,
  literatureSearch = null,
  effort = {},
  verify = null,
  memory = [],
  random = Math.random,
  emit = () => {},
  clock = () => new Date(),
  startedAt: startedAtOverride,
  finalize
}) {
  const send = (event) => emit({ ts: clock().toISOString(), ...event })
  const panelIds = panel.map((a) => a.id)
  const aliases = assignAliases(panelIds, random)
  const aliasOf = (id) => (id === MEMORY_AGENT ? 'sidang sebelumnya' : id === RESEARCH_AGENT ? 'Peneliti' : aliases[id] || id)
  const order = aliasOrder(aliases)
  // Lensa dibagi menurut urutan alias (acak dari seed), jadi sama saat sidang diputar ulang.
  const lensOf = lenses ? Object.fromEntries(order.map((id, i) => [id, LENSES[i % LENSES.length]])) : {}
  const registry = new ClaimRegistry()
  const { usage, track } = createUsage()
  const flags = []
  const startedAt = startedAtOverride ? new Date(startedAtOverride) : clock()

  // Klaim ✅ dari memori masuk daftar klaim lebih dulu (ronde 0), lengkap dengan hasil verifikasinya.
  const memoryIds = {}
  for (const m of memory) {
    memoryIds[m.id] = m.claims.map((c) => {
      const entry = registry.add(c, { agent: MEMORY_AGENT, round: 0 })
      registry.setVerification([[entry.id, c.verification]])
      return entry.id
    })
  }
  const memoryText = memoryBlock(memory, memoryIds)
  const moderatorInfo = { id: moderator.agent.id, label: moderator.agent.label, model: moderator.model || moderator.agent.model || null }
  send({
    type: 'session_started',
    topic,
    panel: panel.map((a) => ({ id: a.id, label: a.label, model: a.model || null, alias: aliases[a.id], ...(lensOf[a.id] ? { lens: lensOf[a.id].label } : {}) })),
    moderator: moderatorInfo,
    maxRounds,
    consensus,
    web,
    verify: Boolean(verify),
    research: Boolean(research),
    ...(memory.length
      ? {
          memory: memory.map((m) => ({ id: m.id, question: m.question, claims: memoryIds[m.id].length })),
          memoryClaims: registry.list().map((c) => ({ id: c.id, text: c.text, kind: c.kind, source_url: c.source_url, quote: c.quote, verification: c.verification }))
        }
      : {})
  })

  const askModerator = async (prompt, validate, stage, { system = MODERATOR_SYSTEM, webSearch = false, searchUses } = {}) => {
    try {
      const r = await askJson(moderator.agent, { system, prompt, model: moderator.model || undefined, webSearch, searchUses, effort: effort[stage], repairEffort: effort.repair }, validate)
      return { ...r, spent: track(r.calls, { role: 'moderator', stage }) }
    } catch (err) {
      if (!isYield(err)) track(err.calls, { role: 'moderator', stage })
      throw err
    }
  }

  // FRAME
  let frame
  try {
    frame = (await askModerator(framePrompt(topic, memoryText, { research: Boolean(research) }), validateFrame, 'frame')).value
  } catch (err) {
    if (isYield(err)) throw err
    frame = { question: topic, criteria: [], context: '', obvious: [], queries: [] }
    send({ type: 'warning', stage: 'frame', message: `Moderator gagal merumuskan pertanyaan (${err.message}); topik dipakai apa adanya.` })
  }
  send({ type: 'framed', ...frame })

  // Sumber literatur (S1, S2, …) dan alamatnya, untuk memetakan source_url "S3" dan mengecek kutipan abstrak.
  let literature = []
  const paperById = new Map()
  const paperByUrl = new Map()
  function indexLiterature(papers) {
    literature = papers
    for (const p of papers) {
      paperById.set(p.id, p)
      for (const u of [p.url, ...(p.altUrls || [])]) if (u) paperByUrl.set(normalizeUrl(u), p)
    }
  }

  // Klaim jawaban panelis dimasukkan ke daftar klaim bersama dan diberi ID global (K1, K2, …).
  // `ids` memetakan ID sementara dari agen (C1, …) ke ID global, untuk rujukan insight.
  function register(agentId, round, response) {
    const ids = {}
    const claims = response.claims.map((c) => {
      const ref = /^S\d+$/i.test(c.source_url) ? paperById.get(c.source_url.toUpperCase()) : null
      const entry = registry.add(ref ? { ...c, source_url: ref.url } : c, { agent: agentId, round })
      if (c.id) ids[c.id.toUpperCase()] = entry.id
      return { id: entry.id, text: entry.text, kind: entry.kind, source_url: entry.source_url, quote: entry.quote, ...(ref ? { source: ref.id } : {}) }
    })
    const cited = response.cited_claims || []
    const unknown = cited.filter((id) => !registry.has(id))
    if (unknown.length) flags.push({ type: 'unknown_citation', agent: agentId, round, detail: unknown.join(', ') })
    return { response: { ...response, claims, cited_claims: cited.filter((id) => registry.has(id)) }, ids }
  }

  // Kutipan dari sumber literatur dicek ke judul + abstrak yang diambil program (tanpa membuka situs penerbit).
  // Yang tidak cocok persis tetap dicek ke halamannya oleh verifier biasa.
  function checkAgainstLiterature(claims) {
    const local = []
    const partial = new Map()
    const rest = []
    for (const c of claims) {
      const paper = c.source_url ? paperByUrl.get(normalizeUrl(c.source_url)) : null
      if (!paper || !c.quote) {
        rest.push(c)
        continue
      }
      const match = matchQuote(c.quote, paperText(paper))
      if (match === 'exact') local.push([c.id, { ...judgeClaim(c, { ok: true, text: paperText(paper) }), detail: `kutipan ada di abstrak ${paper.id}`, source: paper.id }])
      else {
        if (match === 'partial') partial.set(c.id, paper)
        rest.push(c)
      }
    }
    return { local, partial, rest }
  }

  async function runVerification(round) {
    if (!verify) return
    const pending = registry.pending()
    if (!pending.length) return
    try {
      const { local, partial, rest } = checkAgainstLiterature(pending)
      const results = new Map(local)
      if (rest.length) {
        for (const [id, v] of await verify(rest)) {
          const paper = partial.get(id)
          // Halaman penerbit sering tidak bisa dibaca bot; kalau begitu, kecocokan sebagian dengan abstrak lebih informatif.
          results.set(id, paper && v.status !== 'verified' ? { status: 'quote_partial', detail: `kutipan mirip dengan abstrak ${paper.id}, tidak persis`, source: paper.id } : v)
        }
      }
      registry.setVerification(results)
      send({
        type: 'verified',
        round,
        total: pending.length,
        counts: countByStatus(pending),
        claims: pending.map((c) => ({ id: c.id, status: c.verification?.status, detail: c.verification?.detail, source_url: c.source_url, ...(c.verification?.source ? { source: c.verification.source } : {}) }))
      })
    } catch (err) {
      if (isYield(err)) throw err
      send({ type: 'warning', stage: 'verify', round, message: `Verifikasi sumber gagal (${err.message}).` })
    }
  }

  // RISET: literatur dari indeks ilmiah (program), lalu peneliti AI menulis insight bersumber.
  let researched = null
  if (research) {
    const queries = (frame.queries?.length ? frame.queries : [frame.question]).slice(0, research.maxQueries || 6)
    if (literatureSearch) {
      try {
        const found = await literatureSearch(queries)
        indexLiterature(found.papers || [])
        send({ type: 'literature', queries, papers: literature, stats: found.stats || {}, errors: found.errors || [] })
        if (found.errors?.length) {
          const bySource = [...new Set(found.errors.map((e) => `${e.source}: ${e.message}`))]
          send({ type: 'warning', stage: 'literature', message: `Sebagian pencarian literatur gagal (${bySource.join('; ')}).` })
        }
      } catch (err) {
        if (isYield(err)) throw err
        send({ type: 'warning', stage: 'literature', message: `Pencarian literatur gagal (${err.message}); riset hanya memakai web.` })
      }
    }
    const useWeb = web && moderator.agent.capabilities?.webSearch === true
    try {
      const r = await askModerator(
        researchPrompt({ frame, memoryText, literature, webSearch: useWeb, searchBudget: research.searchBudget }),
        validateResearch,
        'research',
        { system: RESEARCHER_SYSTEM, webSearch: useWeb, searchUses: research.searchBudget }
      )
      const { response, ids } = register(RESEARCH_AGENT, 0, { claims: r.value.claims, cited_claims: [] })
      // Rujukan insight: C1 → K…, S dan K yang dikenal tetap; selain itu dibuang.
      const insights = r.value.insights.map((x) => ({
        ...x,
        sources: [...new Set(x.sources.map((ref) => ids[ref] || ref))].filter((ref) => paperById.has(ref) || registry.has(ref))
      }))
      researched = { insights, gaps: r.value.gaps, why_now: r.value.why_now, claims: response.claims }
      const spent = r.calls.reduce((sum, c) => sum + c.ms, 0)
      const search = searchSummary(r.calls)
      send({ type: 'researched', ...researched, ms: spent, repaired: r.repaired, usage: { calls: r.spent.calls, tokens: r.spent.tokens, costUsd: r.spent.costUsd }, search })
      if (search?.fallback) send({ type: 'warning', stage: 'search', agent: RESEARCH_AGENT, message: `Endpoint menolak web search untuk peneliti; dijawab tanpa pencarian (${search.fallback}).` })
      await runVerification(0)
    } catch (err) {
      if (isYield(err)) throw err
      send({ type: 'warning', stage: 'research', message: `Peneliti gagal menulis hasil riset (${err.message}); debat tetap berjalan${literature.length ? ' dengan daftar literatur' : ''}.` })
    }
  }
  // Latar statis untuk semua ronde: memori, literatur, hasil riset.
  const background = [memoryText, literatureBlock(literature), researchBlock(researched)].filter(Boolean).join('\n\n')

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
            ? votePrompt({ frame, background, draft, alias: aliasOf(agent.id), previousVote: previousVotes?.[agent.id], claims, aliasOf })
            : panelPrompt({
                frame,
                background,
                round,
                alias: aliasOf(agent.id),
                lens: lensOf[agent.id],
                researched: Boolean(researched || literature.length),
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
          const response = mode === 'vote' ? r.value : register(agent.id, round, r.value).response
          const ms = r.calls.reduce((sum, c) => sum + c.ms, 0)
          const search = searchSummary(r.calls)
          send({ type: 'agent_finished', round, agent: agent.id, ms, repaired: r.repaired, usage: { calls: spent.calls, tokens: spent.tokens, costUsd: spent.costUsd }, ...(search ? { search } : {}), response })
          if (search?.fallback) send({ type: 'warning', stage: 'search', round, agent: agent.id, message: `Endpoint menolak web search untuk ${aliasOf(agent.id)}; dijawab tanpa pencarian (${search.fallback}).` })
          return [agent.id, { ok: true, ms, repaired: r.repaired, response }]
        } catch (err) {
          if (isYield(err)) throw err
          track(err.calls, { role: agent.id, stage: mode === 'vote' ? 'vote' : 'panel' })
          const ms = err.calls ? err.calls.reduce((sum, c) => sum + c.ms, 0) : Date.now() - start
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
          background,
          round,
          previousDraft: draft,
          responses: ok.map((a) => ({ label: aliasOf(a.id), response: results[a.id].response })),
          failed: panel.filter((a) => !results[a.id].ok).map((a) => ({ label: aliasOf(a.id) })),
          claims: registry.list(),
          aliasOf
        }),
        validateJudge,
        'judge'
      ).then((r) => r.value)
      draft = judged.draft
      entry.judged = judged
      send({ type: 'judged', round, ...judged })
    } catch (err) {
      if (isYield(err)) throw err
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
    memory: memory.map((m) => ({ id: m.id, question: m.question, status: m.status, claims: memoryIds[m.id] })),
    research: research ? { literature, ...(researched || { insights: [], gaps: [], why_now: [], claims: [] }) } : null,
    lenses: Object.fromEntries(Object.entries(lensOf).map(([id, l]) => [id, l.label])),
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
