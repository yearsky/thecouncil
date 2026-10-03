// Model halaman sidang (public/run-state.js): tahap aktif dan stepper dari event sidang sungguhan.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, createRunState, searchesSoFar, stageOf, stepsOf, tokensSoFar } from '../public/run-state.js'
import { runCouncil } from '../src/council/protocol.js'
import { FAKE_PAPER, scriptedAgent } from './helpers.js'

async function eventsOf({ maxRounds = 2, consensus = 'unanimous', verify = true, script = {} } = {}) {
  const events = []
  const panel = ['a', 'b', 'c'].map((id) => scriptedAgent(id, script))
  await runCouncil({
    topic: 'Topik uji',
    panel,
    moderator: { agent: panel[0] },
    maxRounds,
    consensus,
    random: () => 0.999999,
    emit: (e) => events.push(e),
    verify: verify ? async (pending) => new Map(pending.map((c) => [c.id, { status: 'verified', detail: 'uji' }])) : null
  })
  return events
}

// Tahap aktif setelah event ke-i (i = indeks event yang terakhir diterapkan).
function stageAfter(events, predicate) {
  const state = createRunState()
  for (const e of events) {
    applyEvent(state, e)
    if (predicate(e, state)) return { state, stage: stageOf(state, { status: 'running', active: true }) }
  }
  throw new Error('event tidak ditemukan')
}

const active = (stage) => stage.steps.filter((s) => s.status === 'active').map((s) => s.key)

test('stepper: urutan langkah mengikuti jumlah ronde dan verifikasi', () => {
  for (const [maxRounds, verify, expected] of [
    [1, true, ['frame', 'panel-1', 'verify-1', 'judge-1', 'vote', 'done']],
    [2, false, ['frame', 'panel-1', 'judge-1', 'panel-2', 'judge-2', 'vote', 'done']],
    [3, true, ['frame', 'panel-1', 'verify-1', 'judge-1', 'panel-2', 'verify-2', 'judge-2', 'panel-3', 'verify-3', 'judge-3', 'vote', 'done']]
  ]) {
    const state = applyEvent(createRunState(), { type: 'session_started', topic: 't', panel: [], moderator: {}, maxRounds, verify })
    assert.deepEqual(stepsOf(state).map((s) => s.key), expected)
  }
})

test('tahap aktif di tiap titik sidang yang bulat di ronde 2', async () => {
  const events = await eventsOf()
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'session_started').stage), ['frame'])

  const partial = stageAfter(events, (e, s) => e.type === 'agent_finished' && e.round === 1)
  assert.deepEqual(active(partial.stage), ['panel-1'])
  assert.deepEqual(partial.stage.step.progress, { done: 1, total: 3, complete: false })
  assert.match(partial.stage.detail, /tanpa melihat jawaban/)

  let finishedR1 = 0
  const allDone = stageAfter(events, (e) => e.type === 'agent_finished' && e.round === 1 && ++finishedR1 === 3)
  assert.deepEqual(active(allDone.stage), ['verify-1'])
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'verified' && e.round === 1).stage), ['judge-1'])
  // Rangkuman ronde 1 selesai, ronde 2 belum tercatat: ronde 2 dianggap aktif.
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'judged' && e.round === 1).stage), ['panel-2'])
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'round_started' && e.round === 2).stage), ['panel-2'])

  const end = stageAfter(events, (e) => e.type === 'finished')
  assert.equal(end.stage.kind, 'finished')
  const status = Object.fromEntries(end.stage.steps.map((s) => [s.key, s.status]))
  assert.deepEqual(status, { frame: 'done', 'panel-1': 'done', 'verify-1': 'done', 'judge-1': 'done', 'panel-2': 'done', 'verify-2': 'done', 'judge-2': 'skipped', vote: 'skipped', done: 'done' })
})

test('tanpa kesepakatan: suara akhir aktif lalu selesai', async () => {
  const events = await eventsOf({ maxRounds: 1, script: { VOTE: { vote: { on_draft: 'DISAGREE', blocking_objections: ['x'] } } } })
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'round_started' && e.mode === 'vote').stage), ['vote'])
  const end = stageAfter(events, (e) => e.type === 'finished')
  const status = Object.fromEntries(end.stage.steps.map((s) => [s.key, s.status]))
  assert.equal(status['judge-1'], 'done')
  assert.equal(status.vote, 'done')
  assert.equal(end.state.finished.decidedBy, 'vote')
})

test('dibatalkan, gagal, dijeda, dan verifikasi mati', async () => {
  const events = await eventsOf({ verify: false })
  const upTo = (n) => {
    const s = createRunState()
    for (const e of events.slice(0, n)) applyEvent(s, e)
    return s
  }
  const mid = upTo(events.findIndex((e) => e.type === 'round_started' && e.round === 1) + 1)
  assert.ok(!stepsOf(mid).some((s) => s.key.startsWith('verify')))
  assert.equal(stageOf(mid, { status: 'running', active: false }).kind, 'paused')

  applyEvent(mid, { type: 'cancelled', message: 'Sidang dibatalkan.' })
  const cancelled = stageOf(mid, { status: 'cancelled' })
  assert.equal(cancelled.kind, 'cancelled')
  assert.ok(cancelled.steps.filter((s) => s.key !== 'frame').every((s) => s.status === 'skipped'))

  const fresh = upTo(3)
  assert.equal(stageOf(fresh, { status: 'error', error: 'Redis penuh' }).detail, 'Redis penuh')
  assert.equal(stageOf(createRunState()).kind, 'waiting')
})

test('klaim terkumpul dengan status verifikasi; token panelis dijumlahkan', async () => {
  const events = await eventsOf()
  const state = createRunState()
  for (const e of events.filter((x) => x.type !== 'finished')) applyEvent(state, e)
  assert.ok(state.claims.size > 0)
  assert.ok([...state.claims.values()].every((c) => c.verification?.status === 'verified'))
  assert.deepEqual([...state.claims.get('K1').by], ['a'])
  const t = tokensSoFar(state)
  assert.equal(t.complete, false)
  assert.equal(t.output, 10 * 6) // 6 jawaban panelis × 10 token (agen palsu)
})

test('tahap riset: aktif setelah pertanyaan dirumuskan sampai ronde 1 mulai; klaim riset dan pencarian tercatat', async () => {
  const events = []
  const panel = ['a', 'b'].map((id) => scriptedAgent(id, {}, { webSearch: true, searches: 2 }))
  await runCouncil({
    topic: 'Topik uji',
    panel,
    moderator: { agent: panel[0] },
    maxRounds: 2,
    random: () => 0.999999,
    emit: (e) => events.push(e),
    research: { enabled: true, searchBudget: 6 },
    literatureSearch: async () => ({ papers: [FAKE_PAPER], errors: [], stats: {} }),
    verify: async (pending) => new Map(pending.map((c) => [c.id, { status: 'verified', detail: 'uji' }]))
  })
  assert.deepEqual(stepsOf(applyEvent(createRunState(), events[0])).map((s) => s.key).slice(0, 3), ['frame', 'research', 'panel-1'])
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'framed').stage), ['research'])
  const lit = stageAfter(events, (e) => e.type === 'literature')
  assert.deepEqual(active(lit.stage), ['research'])
  assert.match(lit.stage.step.note, /1 sumber ilmiah ditemukan/)
  const researched = stageAfter(events, (e) => e.type === 'verified' && e.round === 0)
  assert.deepEqual(active(researched.stage), ['research'])
  assert.ok(!researched.state.rounds.has(0), 'verifikasi riset bukan ronde debat')
  assert.equal(researched.state.researchVerified.total, 2)
  assert.deepEqual(active(stageAfter(events, (e) => e.type === 'round_started' && e.round === 1).stage), ['panel-1'])

  const end = stageAfter(events, (e) => e.type === 'finished').state
  assert.equal(end.research.insights.length, 2)
  assert.equal(end.literature.papers[0].id, 'S1')
  assert.deepEqual([...end.claims.values()].find((c) => c.source === 'S1')?.verification, { status: 'verified', detail: 'kutipan ada di abstrak S1', source: 'S1' })
  assert.deepEqual(searchesSoFar(end), { requests: 2 * 4 + 2, calls: 5, withoutSearch: 0 })
  assert.ok(tokensSoFar(end).complete)
})
