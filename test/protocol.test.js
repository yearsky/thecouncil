import test from 'node:test'
import assert from 'node:assert/strict'
import { runCouncil } from '../src/council/protocol.js'
import { scriptedAgent } from './helpers.js'

const CLOCK = () => new Date('2026-10-02T08:00:00Z')

async function council({ panel, moderator = panel[0], moderatorModel = 'mod-model', ...opts }) {
  const events = []
  const result = await runCouncil({
    topic: 'Ide hackathon',
    panel,
    moderator: { agent: moderator, model: moderatorModel },
    emit: (e) => events.push(e),
    clock: CLOCK,
    random: () => 0.999999, // urutan alias = urutan panel: a = Panelis A, b = Panelis B, …
    ...opts
  })
  return { result, events, types: events.map((e) => e.type) }
}

const disagreeAfterRound1 = ({ id, round }) => ({
  position: `posisi ${id} r${round}`,
  ...(round > 1 ? { vote: { on_draft: 'DISAGREE', blocking_objections: ['kurang data'] } } : {})
})

test('semua setuju di ronde 2 → bulat, kesimpulan = draft ronde 1', async () => {
  const panel = ['a', 'b', 'c'].map((id) => scriptedAgent(id))
  const { result, events, types } = await council({ panel })

  assert.equal(result.status, 'unanimous')
  assert.deepEqual(result.decided && [result.decided.round, result.decided.draftRound], [2, 1])
  assert.equal(result.final.draft, 'draft r1')
  assert.equal(result.rounds.length, 2)
  assert.equal(result.rounds[1].judged, undefined)

  assert.equal(types[0], 'session_started')
  assert.equal(types[1], 'framed')
  assert.equal(types.at(-1), 'finished')
  assert.equal(types.filter((t) => t === 'agent_finished').length, 6)
  assert.equal(types.filter((t) => t === 'judged').length, 1)
  assert.equal(events.at(-1).status, 'unanimous')
  assert.equal(events.at(-1).decidedBy, 'critique')
  assert.equal(events[0].ts, '2026-10-02T08:00:00.000Z')

  // Moderator (agen a) dipanggil untuk FRAME dan JUDGE dengan model moderator; sebagai panelis tanpa model khusus.
  const modCalls = panel[0].calls.filter((c) => /^Tahap: (FRAME|JUDGE)/m.test(c.prompt))
  assert.equal(modCalls.length, 2)
  assert.ok(modCalls.every((c) => c.model === 'mod-model'))
  assert.ok(panel[0].calls.filter((c) => /^Tahap: PANEL/m.test(c.prompt)).every((c) => c.model === undefined))
  assert.equal(result.usage.calls, 8)
  assert.equal(result.usage.costUsd.toFixed(2), '0.08')
})

test('ronde kritik: panelis melihat draft, posisinya sendiri, dan jawaban panelis lain', async () => {
  const panel = ['a', 'b'].map((id) => scriptedAgent(id))
  await council({ panel })
  const round2 = panel[0].calls.find((c) => /^Tahap: PANEL · Ronde 2/m.test(c.prompt))
  assert.match(round2.prompt, /draft r1/)
  assert.match(round2.prompt, /Fokus ronde ini dari moderator: fokus r1/)
  assert.match(round2.prompt, /Posisimu di ronde sebelumnya:\n<<<\nposisi a r1/)
  assert.match(round2.prompt, /## Panelis B\nPosisi: posisi b r1/)
  assert.doesNotMatch(round2.prompt, /## Panelis A\n/)
})

test('tidak pernah sepakat → suara akhir setelah batas ronde → tidak ada konsensus', async () => {
  const panel = ['a', 'b'].map((id) => scriptedAgent(id, { PANEL: disagreeAfterRound1, VOTE: { vote: { on_draft: 'DISAGREE' } } }))
  const { result, events } = await council({ panel, maxRounds: 2 })
  assert.equal(result.status, 'no_consensus')
  assert.deepEqual(result.rounds.map((r) => r.mode), ['blind', 'critique', 'vote'])
  assert.equal(result.final.draft, 'draft r2')
  assert.equal(result.decided.draftRound, 2)
  assert.equal(events.filter((e) => e.type === 'votes').at(-1).final, true)
  assert.equal(events.at(-1).decidedBy, 'vote')
})

test('mode mayoritas berhenti saat mayoritas; mode bulat lanjut sampai suara akhir', async () => {
  const make = () => [scriptedAgent('a'), scriptedAgent('b'), scriptedAgent('c', { PANEL: disagreeAfterRound1, VOTE: { vote: { on_draft: 'DISAGREE' } } })]

  const majority = await council({ panel: make(), consensus: 'majority' })
  assert.equal(majority.result.status, 'majority')
  assert.equal(majority.result.rounds.length, 2)

  const unanimous = await council({ panel: make(), maxRounds: 2 })
  assert.equal(unanimous.result.status, 'majority')
  assert.equal(unanimous.result.rounds.at(-1).mode, 'vote')
})

test('JSON rusak diperbaiki sekali; kalau tetap rusak, panelis itu gagal di ronde tersebut', async () => {
  const fixable = scriptedAgent('a', {
    PANEL: ({ n }) => (n === 1 ? 'maaf, ini bukan json' : { position: 'tidak dipakai' }),
    REPAIR: { position: 'posisi setelah diperbaiki' }
  })
  const broken = scriptedAgent('b', { PANEL: 'tetap bukan json', REPAIR: 'masih bukan json' })
  const ok = scriptedAgent('c')
  const { result, events } = await council({ panel: [fixable, broken, ok], moderator: ok, maxRounds: 1 })

  const finished = events.find((e) => e.type === 'agent_finished' && e.agent === 'a' && e.round === 1)
  assert.equal(finished.repaired, true)
  assert.equal(finished.response.position, 'posisi setelah diperbaiki')
  const repairCall = fixable.calls.find((c) => c.prompt.startsWith('Jawabanmu sebelumnya'))
  assert.equal(repairCall.webSearch, false)

  const failed = events.find((e) => e.type === 'agent_failed' && e.agent === 'b')
  assert.match(failed.error, /juga setelah diminta perbaikan/)
  assert.equal(result.rounds[0].results.b.ok, false)
  assert.ok(result.usage.calls >= 4)
})

test('panelis gagal di ronde 1 tapi pulih di ronde 2 → tetap bisa bulat', async () => {
  const flaky = scriptedAgent('a', {
    PANEL: ({ id, round }) => (round === 1 ? new Error('Claude tidak merespons dalam 300 detik') : { position: `posisi ${id}`, vote: { on_draft: 'AGREE' } })
  })
  const panel = [flaky, scriptedAgent('b')]
  const { result, events } = await council({ panel, moderator: panel[1] })
  assert.equal(events.find((e) => e.type === 'agent_failed').error, 'Claude tidak merespons dalam 300 detik')
  const judgeCall = panel[1].calls.find((c) => /^Tahap: JUDGE/m.test(c.prompt))
  assert.match(judgeCall.prompt, /## Panelis A\nGagal menjawab di ronde ini\./)
  const round2 = flaky.calls.find((c) => /^Tahap: PANEL · Ronde 2/m.test(c.prompt))
  assert.doesNotMatch(round2.prompt, /Posisimu di ronde sebelumnya/)
  assert.equal(result.status, 'unanimous')
})

test('semua panelis gagal → status error', async () => {
  const panel = ['a', 'b'].map((id) => scriptedAgent(id, { PANEL: new Error('down') }))
  const mod = scriptedAgent('m')
  const { result, events } = await council({ panel, moderator: mod })
  assert.equal(result.status, 'error')
  assert.equal(events.at(-1).status, 'error')
  assert.ok(events.some((e) => e.type === 'warning' && e.stage === 'panel'))
  assert.equal(mod.calls.filter((c) => /^Tahap: JUDGE/m.test(c.prompt)).length, 0)
})

test('moderator gagal merumuskan → topik dipakai apa adanya, sidang tetap jalan', async () => {
  const mod = scriptedAgent('m', { FRAME: 'bukan json', REPAIR: 'tetap bukan json' })
  const { result, events } = await council({ panel: [scriptedAgent('a'), scriptedAgent('b')], moderator: mod })
  assert.equal(result.frame.question, 'Ide hackathon')
  assert.ok(events.some((e) => e.type === 'warning' && e.stage === 'frame'))
  assert.equal(result.status, 'unanimous')
})

test('web search hanya untuk agen yang mendukung, tidak saat suara akhir, dan bisa dimatikan', async () => {
  const webby = scriptedAgent('a', { PANEL: disagreeAfterRound1, VOTE: { vote: { on_draft: 'DISAGREE' } } }, { webSearch: true })
  const plain = scriptedAgent('b')
  await council({ panel: [webby, plain], moderator: plain, maxRounds: 1 })
  assert.equal(webby.calls.find((c) => /^Tahap: PANEL/m.test(c.prompt)).webSearch, true)
  assert.equal(webby.calls.find((c) => /^Tahap: VOTE/m.test(c.prompt)).webSearch, false)
  assert.equal(plain.calls.find((c) => /^Tahap: PANEL/m.test(c.prompt)).webSearch, false)

  const off = scriptedAgent('c', {}, { webSearch: true })
  await council({ panel: [off], web: false, maxRounds: 1 })
  assert.ok(off.calls.every((c) => c.webSearch === false))
})

test('finalize dipanggil sebelum event finished, dan hasilnya ikut di event itu', async () => {
  const order = []
  const { events } = await council({
    panel: [scriptedAgent('a')],
    finalize: async (res) => {
      order.push(`finalize:${res.status}`)
      return { report: 'sessions/x/report.md' }
    }
  })
  assert.deepEqual(order, ['finalize:unanimous'])
  assert.equal(events.at(-1).report, 'sessions/x/report.md')
})
