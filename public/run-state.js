// Model halaman sidang, dibangun dari event sidang (docs/PLAN.md §10). Tanpa DOM, supaya bisa diuji dengan
// node --test. run-view.js merender model ini; tahap aktif dan stepper diturunkan dari sini, bukan ditebak di UI.
//
// Urutan sidang (src/council/protocol.js): rumuskan pertanyaan → [riset: literatur + peneliti + cek sumber] →
// untuk tiap ronde: jawaban panelis → cek sumber (kalau ada klaim baru) → [ronde kritik: hitung suara, berhenti
// kalau sudah sepakat] → rangkuman moderator → … → suara akhir (kalau batas ronde habis tanpa kesepakatan) → hasil.

export function createRunState() {
  return {
    topic: '',
    panel: [],
    labels: {},
    moderator: null,
    maxRounds: 0,
    consensus: 'unanimous',
    web: true,
    verify: true,
    researchEnabled: false,
    memory: [],
    startedAt: null,
    frame: null,
    literature: null, // { queries, papers, stats, errors }
    research: null, // { insights, gaps, why_now, claims, ms, usage, search }
    researchVerified: null,
    rounds: new Map(),
    claims: new Map(),
    warnings: [],
    flags: [],
    finished: null,
    cancelled: null,
    lastAt: null
  }
}

function roundOf(state, n) {
  let r = state.rounds.get(n)
  if (!r) {
    r = { round: n, mode: null, devil: null, startedAt: null, agents: {}, verified: null, votes: null, judged: null }
    state.rounds.set(n, r)
  }
  return r
}

function addClaims(state, agent, claims = []) {
  for (const c of claims) {
    if (!c?.id) continue
    const known = state.claims.get(c.id)
    const by = new Set(known?.by || [])
    by.add(agent)
    state.claims.set(c.id, { ...c, ...(known || {}), by })
  }
}

export function applyEvent(state, e) {
  if (e.ts) state.lastAt = e.ts
  switch (e.type) {
    case 'session_started':
      state.topic = e.topic
      state.panel = e.panel || []
      state.moderator = e.moderator || null
      state.maxRounds = e.maxRounds || 0
      state.consensus = e.consensus || 'unanimous'
      state.web = e.web !== false
      state.verify = e.verify !== false
      state.researchEnabled = Boolean(e.research)
      state.memory = e.memory || []
      state.startedAt = e.ts || null
      for (const p of state.panel) state.labels[p.id] = p.alias ? `${p.alias} · ${p.label}` : p.label
      state.labels.memori = 'sidang sebelumnya'
      state.labels.peneliti = 'Peneliti'
      for (const c of e.memoryClaims || []) state.claims.set(c.id, { ...c, by: new Set(['memori']) })
      break
    case 'framed':
      state.frame = { question: e.question, criteria: e.criteria || [], context: e.context || '', obvious: e.obvious || [], queries: e.queries || [] }
      break
    case 'literature':
      state.literature = { queries: e.queries || [], papers: e.papers || [], stats: e.stats || {}, errors: e.errors || [] }
      break
    case 'researched':
      state.research = { insights: e.insights || [], gaps: e.gaps || [], why_now: e.why_now || [], claims: e.claims || [], ms: e.ms, usage: e.usage, search: e.search || null, at: e.ts || null }
      addClaims(state, 'peneliti', e.claims)
      break
    case 'round_started': {
      const r = roundOf(state, e.round)
      r.mode = e.mode
      r.devil = e.devilsAdvocate || null
      r.startedAt = e.ts || null
      break
    }
    case 'agent_started':
      roundOf(state, e.round).agents[e.agent] = { status: 'running', startedAt: e.ts || null }
      break
    case 'agent_finished':
      roundOf(state, e.round).agents[e.agent] = { status: 'done', ms: e.ms, repaired: e.repaired, usage: e.usage, search: e.search || null, response: e.response || {} }
      addClaims(state, e.agent, e.response?.claims)
      break
    case 'agent_failed':
      roundOf(state, e.round).agents[e.agent] = { status: 'failed', ms: e.ms, error: e.error }
      break
    case 'verified': {
      // Ronde 0 = klaim dari tahap riset (sebelum ronde debat pertama).
      const summary = { total: e.total, counts: e.counts || {} }
      if (e.round === 0) state.researchVerified = summary
      else roundOf(state, e.round).verified = summary
      for (const v of e.claims || []) {
        const c = state.claims.get(v.id)
        if (c) c.verification = { status: v.status, detail: v.detail, ...(v.source ? { source: v.source } : {}) }
      }
      break
    }
    case 'votes':
      roundOf(state, e.round).votes = { draftRound: e.draftRound, status: e.status, accepted: e.accepted || [], rejected: e.rejected || [], total: e.total, votes: e.votes || {}, final: Boolean(e.final) }
      break
    case 'judged':
      roundOf(state, e.round).judged = { summary: e.summary, agreements: e.agreements || [], disagreements: e.disagreements || [], draft: e.draft, next_focus: e.next_focus }
      break
    case 'flags':
      state.flags.push(...(e.flags || []))
      break
    case 'warning':
      state.warnings.push({ stage: e.stage, round: e.round, message: e.message })
      break
    case 'finished':
      state.finished = e
      break
    case 'cancelled':
      state.cancelled = e
      break
    default:
      break
  }
  return state
}

export const debateRounds = (state) => [...state.rounds.values()].filter((r) => r.mode !== 'vote').sort((a, b) => a.round - b.round)
export const finalVoteRound = (state) => [...state.rounds.values()].find((r) => r.mode === 'vote') || null

const panelProgress = (state, r) => {
  const ids = state.panel.map((p) => p.id)
  const done = ids.filter((id) => ['done', 'failed'].includes(r?.agents[id]?.status)).length
  return { done, total: ids.length, complete: ids.length > 0 && done === ids.length }
}

// Apakah ada kejadian setelah tahap panel ronde n (berarti cek sumber ronde itu sudah lewat)?
function afterPanel(state, n) {
  const r = state.rounds.get(n)
  return Boolean(r?.votes || r?.judged || state.rounds.has(n + 1) || finalVoteRound(state) || state.finished)
}

const TEXT = {
  frame: 'Moderator mengubah topikmu menjadi pertanyaan sidang, kriteria keberhasilan, dan daftar jawaban klise yang harus dilampaui.',
  research:
    'Program mencari paper di Semantic Scholar, OpenAlex, dan arXiv. Peneliti AI membaca abstraknya, mencari laporan, regulasi, dan thesis di web, lalu menulis temuan yang tidak umum diketahui.',
  blind: 'Panelis menjawab sendiri-sendiri tanpa melihat jawaban yang lain, sambil mencari data di web.',
  critique: 'Panelis membaca draft moderator dan jawaban panelis lain, mengkritik, lalu memberi suara atas draft.',
  verify: 'Program membuka setiap sumber yang dikutip dan mencari kutipannya di halaman itu.',
  judge: 'Moderator merangkum ronde ini dan menyusun draft kesimpulan. Hanya klaim ✅ yang boleh jadi dasar.',
  vote: 'Batas ronde habis tanpa kesepakatan. Panelis memberi suara terakhir atas draft moderator.',
  done: 'Sidang selesai. Hasil dan laporan lengkap tersedia.'
}

// Daftar langkah sidang dengan statusnya: done | active | pending | skipped. `run` = ringkasan sidang dari server
// (status, active), dipakai untuk keadaan dibatalkan/gagal/dijeda.
export function stepsOf(state, run = {}) {
  const ended = Boolean(state.finished || state.cancelled || ['cancelled', 'error'].includes(run.status))
  const steps = []
  const push = (key, title, status, extra = {}) => steps.push({ key, title, status, ...extra })

  push('frame', 'Rumuskan pertanyaan', state.frame ? 'done' : ended ? 'skipped' : 'active', { detail: TEXT.frame })

  if (state.researchEnabled) {
    // Selesai saat ronde 1 dimulai (cek sumber klaim riset termasuk di tahap ini).
    let s = 'pending'
    if (state.rounds.has(1) || (ended && state.research)) s = 'done'
    else if (ended) s = 'skipped'
    else if (state.frame) s = 'active'
    const found = state.literature ? `${state.literature.papers.length} sumber ilmiah ditemukan` : null
    push('research', 'Riset literatur & insight', s, { detail: TEXT.research, note: state.research ? `${state.research.insights.length} insight ditulis; sumbernya sedang dicek.` : found ? `${found}; peneliti sedang membaca.` : null })
  }

  let reachedConsensus = false
  const n = Math.max(state.maxRounds, debateRounds(state).length)
  for (let i = 1; i <= n; i++) {
    const r = state.rounds.get(i)
    const mode = i === 1 ? 'blind' : 'critique'
    const prog = panelProgress(state, r)
    const skippedAll = reachedConsensus || (ended && !r)
    const panelStatus = skippedAll ? 'skipped' : !r ? 'pending' : prog.complete ? 'done' : ended ? 'skipped' : 'active'
    push(`panel-${i}`, mode === 'blind' ? `Ronde ${i} · jawaban independen` : `Ronde ${i} · kritik & suara`, panelStatus, {
      detail: mode === 'blind' ? TEXT.blind : TEXT.critique,
      progress: r ? prog : null,
      round: i
    })

    if (state.verify) {
      let s = 'pending'
      if (skippedAll) s = 'skipped'
      else if (r?.verified || (prog.complete && afterPanel(state, i))) s = 'done'
      else if (prog.complete) s = ended ? 'skipped' : 'active'
      else if (ended) s = 'skipped'
      push(`verify-${i}`, 'Cek sumber', s, { detail: TEXT.verify, round: i })
    }

    // Ronde kritik yang sudah mencapai konsensus berhenti tanpa rangkuman.
    const decidedHere = Boolean(r?.votes && state.finished && state.finished.round === i && state.finished.decidedBy === 'critique')
    let j = 'pending'
    if (skippedAll || decidedHere) j = 'skipped'
    else if (r?.judged) j = 'done'
    else if (prog.complete && (state.verify ? r?.verified || afterPanel(state, i) : true)) j = ended ? 'skipped' : 'active'
    else if (ended) j = 'skipped'
    push(`judge-${i}`, mode === 'blind' ? 'Rangkuman & draft moderator' : 'Hitung suara & rangkuman', j, { detail: TEXT.judge, round: i })
    if (decidedHere) reachedConsensus = true
  }

  const fv = finalVoteRound(state)
  const fvProg = panelProgress(state, fv)
  let v = 'pending'
  if (fv) v = fvProg.complete || fv.votes ? 'done' : ended ? 'skipped' : 'active'
  else if (ended || reachedConsensus) v = 'skipped'
  push('vote', 'Suara akhir', v, { detail: TEXT.vote, progress: fv ? fvProg : null, round: fv?.round })

  push('done', 'Hasil', state.finished ? 'done' : ended ? 'skipped' : 'pending', { detail: TEXT.done })
  return steps
}

// Tahap yang sedang berjalan (atau keadaan akhir), untuk judul kartu "Sedang berlangsung" dan bar ringkas HP.
export function stageOf(state, run = {}) {
  const steps = stepsOf(state, run)
  const index = steps.findIndex((s) => s.status === 'active')
  if (state.finished) return { kind: 'finished', title: 'Sidang selesai', detail: TEXT.done, steps, index: steps.length - 1 }
  if (state.cancelled || run.status === 'cancelled') return { kind: 'cancelled', title: 'Sidang dibatalkan', detail: 'Panggilan yang sedang berjalan diselesaikan dulu, lalu sidang dihentikan.', steps, index }
  if (run.status === 'error') return { kind: 'error', title: 'Sidang berhenti karena error', detail: run.error || 'Lihat peringatan di tab Detail.', steps, index }
  if (!state.startedAt) return { kind: 'waiting', title: 'Menunggu sidang dimulai', detail: 'Server sedang menyiapkan sidang.', steps, index: 0 }
  // Jeda singkat di antara dua tahap (mis. rangkuman selesai, ronde berikutnya belum tercatat): tahap berikutnya
  // yang belum jalan dianggap aktif.
  let at = index
  if (at === -1) {
    at = steps.findIndex((s) => s.status === 'pending')
    if (at !== -1) steps[at] = { ...steps[at], status: 'active' }
  }
  const step = steps[at]
  const index_ = at
  const paused = run.status === 'running' && run.active === false
  return { kind: paused ? 'paused' : 'running', title: step.title, detail: step.detail, step, steps, index: index_ }
}

// Token panelis yang sudah terpakai (moderator baru dilaporkan di akhir sidang).
export function tokensSoFar(state) {
  if (state.finished?.usage?.tokens) return { ...state.finished.usage.tokens, complete: true }
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, complete: false }
  const add = (u) => {
    if (!u) return
    t.input += u.input || 0
    t.cacheRead += u.cacheRead || 0
    t.cacheWrite += u.cacheWrite || 0
    t.output += u.output || 0
  }
  add(state.research?.usage?.tokens)
  for (const r of state.rounds.values()) {
    for (const a of Object.values(r.agents)) add(a.usage?.tokens)
  }
  return t
}

// Pencarian web yang dilaporkan penyedia (peneliti + panelis). null kalau tidak ada agen yang diberi web search.
export function searchesSoFar(state) {
  const all = [state.research?.search, ...[...state.rounds.values()].flatMap((r) => Object.values(r.agents).map((a) => a.search))].filter(Boolean)
  if (!all.length) return null
  return { requests: all.reduce((n, s) => n + (s.requests || 0), 0), calls: all.length, withoutSearch: all.filter((s) => !s.requests).length }
}
