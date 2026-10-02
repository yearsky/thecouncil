import test from 'node:test'
import assert from 'node:assert/strict'
import { addTokens, fromAnthropicUsage, fromOpenAiUsage, totalInput } from '../src/agents/usage.js'
import { aliasOrder, assignAliases } from '../src/council/anonymize.js'
import { ClaimRegistry, registryBlock } from '../src/council/claims.js'
import { runCouncil } from '../src/council/protocol.js'
import { scriptedAgent } from './helpers.js'

const IDENTITY = () => 0.999999 // urutan alias = urutan panel

async function council({ panel, moderator = panel[0], ...opts }) {
  const events = []
  const result = await runCouncil({
    topic: 'Topik uji',
    panel,
    moderator: { agent: moderator, model: 'mod' },
    emit: (e) => events.push(e),
    random: IDENTITY,
    ...opts
  })
  return { result, events }
}

const disagreeThenAgree = (because) => ({ round }) =>
  round === 2
    ? { position: 'p2', vote: { on_draft: 'DISAGREE', blocking_objections: ['kurang data'] } }
    : { position: `p${round}`, ...(round > 1 ? { vote: { on_draft: 'AGREE' }, changed_mind: because ? { changed: true, what: 'setuju', because } : { changed: false } } : {}) }

test('ClaimRegistry menggabungkan klaim yang sama dari panelis/ronde berbeda', () => {
  const reg = new ClaimRegistry()
  const a = reg.add({ text: 'IASC 411.055 laporan', kind: 'fact', source_url: 'https://ojk.go.id/x?utm_source=a', quote: 'menerima 411.055 laporan' }, { agent: 'a', round: 1 })
  const b = reg.add({ text: 'IASC menerima 411.055 laporan (Des 2025)', kind: 'fact', source_url: 'https://ojk.go.id/x', quote: 'Menerima 411.055 laporan' }, { agent: 'b', round: 2 })
  const c = reg.add({ text: 'Opini tanpa sumber', kind: 'opinion', source_url: '', quote: '' }, { agent: 'b', round: 1 })
  assert.equal(a, b)
  assert.deepEqual([a.id, c.id], ['K1', 'K2'])
  assert.deepEqual(a.by, ['a', 'b'])
  assert.deepEqual(a.rounds, [1, 2])
  assert.deepEqual(reg.pending().map((x) => x.id), ['K1']) // opini tanpa URL tidak perlu dicek

  reg.setVerification(new Map([['K1', { status: 'verified', detail: 'kutipan ditemukan' }]]))
  const block = registryBlock(reg.list(), (id) => `Panelis ${id.toUpperCase()}`)
  assert.match(block, /^K1 ✅ fact: IASC 411\.055 laporan \| https:\/\/ojk\.go\.id\/x\?utm_source=a \| kutipan: "menerima 411\.055 laporan" \| oleh Panelis A, Panelis B$/m)
  assert.match(block, /^K2 · opinion: Opini tanpa sumber \| oleh Panelis B$/m)
  assert.equal(registryBlock([]), '')
})

test('registryBlock tidak menyertakan kutipan yang belum terbukti', () => {
  const reg = new ClaimRegistry()
  reg.add({ text: 't', kind: 'fact', source_url: 'https://x.test', quote: 'kutipan karangan' }, { agent: 'a', round: 1 })
  reg.setVerification(new Map([['K1', { status: 'quote_not_found', detail: 'halaman terbuka, kutipan tidak ditemukan' }]]))
  const block = registryBlock(reg.list())
  assert.doesNotMatch(block, /kutipan karangan/)
  assert.match(block, /K1 ⚠️ fact: t \| https:\/\/x\.test \| halaman terbuka, kutipan tidak ditemukan/)
})

test('assignAliases mengacak tapi bisa dibuat tetap; aliasOrder mengikuti huruf', () => {
  assert.deepEqual(assignAliases(['a', 'b', 'c'], IDENTITY), { a: 'Panelis A', b: 'Panelis B', c: 'Panelis C' })
  const shuffled = assignAliases(['a', 'b', 'c'], () => 0)
  assert.deepEqual(Object.values(shuffled).sort(), ['Panelis A', 'Panelis B', 'Panelis C'])
  assert.deepEqual(aliasOrder(shuffled).map((id) => shuffled[id]), ['Panelis A', 'Panelis B', 'Panelis C'])
})

test('konversi token Anthropic dan OpenAI/DeepSeek', () => {
  assert.deepEqual(fromAnthropicUsage({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 }), { input: 10, cacheRead: 90, cacheWrite: 5, output: 7 })
  assert.deepEqual(fromOpenAiUsage({ prompt_tokens: 100, completion_tokens: 9, prompt_cache_hit_tokens: 60 }), { input: 40, cacheRead: 60, cacheWrite: 0, output: 9 })
  assert.deepEqual(fromOpenAiUsage({ prompt_tokens: 50, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 10 } }), { input: 40, cacheRead: 10, cacheWrite: 0, output: 1 })
  assert.equal(fromAnthropicUsage(undefined), null)
  const t = addTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 })
  assert.equal(totalInput(t), 9)
})

test('verifikasi: klaim diberi ID global, dicek setelah tiap ronde, statusnya terlihat di prompt berikutnya', async () => {
  const shared = { text: 'fakta bersama', kind: 'fact', source_url: 'https://sumber.test/a', quote: 'kutipan asli' }
  const a = scriptedAgent('a', { PANEL: ({ round }) => ({ position: 'pa', claims: [shared, { text: 'karangan', kind: 'fact', source_url: 'https://palsu.test', quote: 'q' }], ...(round > 1 ? { vote: { on_draft: 'AGREE' } } : {}) }) })
  const b = scriptedAgent('b', { PANEL: ({ round }) => ({ position: 'pb', claims: [shared], cited_claims: ['K9'], ...(round > 1 ? { vote: { on_draft: 'AGREE' } } : {}) }) })
  const seen = []
  const verify = async (claims) => {
    seen.push(claims.map((c) => c.id))
    return new Map(claims.map((c) => [c.id, c.source_url.includes('palsu') ? { status: 'unreachable', detail: 'HTTP 404' } : { status: 'verified', detail: 'kutipan ditemukan' }]))
  }
  const { result, events } = await council({ panel: [a, b], verify })

  assert.deepEqual(seen, [['K1', 'K2']]) // ronde 2 tidak mengecek ulang klaim yang sama
  const verified = events.find((e) => e.type === 'verified')
  assert.deepEqual(verified.counts, { verified: 1, unreachable: 1 })
  const finishedA = events.find((e) => e.type === 'agent_finished' && e.agent === 'a' && e.round === 1)
  assert.deepEqual(finishedA.response.claims.map((c) => c.id), ['K1', 'K2'])
  assert.deepEqual(result.claims.find((c) => c.id === 'K1').by, ['a', 'b'])

  const judge = a.calls.find((c) => /^Tahap: JUDGE/m.test(c.prompt))
  assert.match(judge.prompt, /K1 ✅ fact: fakta bersama \| https:\/\/sumber\.test\/a \| kutipan: "kutipan asli"/)
  assert.match(judge.prompt, /K2 ❌ fact: karangan \| https:\/\/palsu\.test \| HTTP 404/)
  const round2 = b.calls.find((c) => /^Tahap: PANEL · Ronde 2/m.test(c.prompt))
  assert.match(round2.prompt, /K1 ✅/)

  // Rujukan ke ID yang tidak ada dicatat dan dibuang.
  assert.ok(result.flags.some((f) => f.type === 'unknown_citation' && f.agent === 'b' && f.detail === 'K9'))
  assert.deepEqual(events.find((e) => e.type === 'agent_finished' && e.agent === 'b').response.cited_claims, [])
  assert.deepEqual(events.at(-1).verification, { verified: 1, unreachable: 1 })
})

test('anonim: prompt ke agen tidak pernah memuat nama model panelis', async () => {
  const panel = ['a', 'b'].map((id) => Object.assign(scriptedAgent(id), { label: `Claude Model-${id}` }))
  await council({ panel })
  const prompts = panel.flatMap((p) => p.calls.map((c) => c.prompt))
  assert.ok(prompts.length > 4)
  assert.ok(prompts.every((p) => !/Claude Model-/.test(p)))
  assert.ok(prompts.some((p) => /Kamu adalah Panelis A\./.test(p)))
})

test("devil's advocate bergiliran per ronde kritik menurut urutan alias", async () => {
  const no = { PANEL: ({ round }) => ({ position: `p${round}`, ...(round > 1 ? { vote: { on_draft: 'DISAGREE', blocking_objections: ['x'] } } : {}) }), VOTE: { vote: { on_draft: 'DISAGREE', blocking_objections: ['x'] } } }
  const panel = ['a', 'b', 'c'].map((id) => scriptedAgent(id, no))
  const { result, events } = await council({ panel, maxRounds: 3 })
  assert.deepEqual(events.filter((e) => e.type === 'round_started').map((e) => e.devilsAdvocate || null), [null, 'a', 'b', null])
  assert.deepEqual(result.rounds.map((r) => r.devilsAdvocate || null), [null, 'a', 'b', null])
  const daPrompts = (agent) => agent.calls.filter((c) => /giliran sebagai devil's advocate/.test(c.prompt)).map((c) => c.prompt.match(/Ronde (\d+)/)[1])
  assert.deepEqual(daPrompts(panel[0]), ['2'])
  assert.deepEqual(daPrompts(panel[1]), ['3'])
  assert.deepEqual(daPrompts(panel[2]), [])

  const off = await council({ panel: ['a', 'b'].map((id) => scriptedAgent(id, no)), maxRounds: 2, devilsAdvocate: false })
  assert.ok(off.events.every((e) => !e.devilsAdvocate))
})

test('catatan integritas: suara bertentangan dan perubahan suara tanpa penjelasan', async () => {
  const contradictory = scriptedAgent('a', { PANEL: ({ round }) => ({ position: 'p', ...(round > 1 ? { vote: { on_draft: 'AGREE', blocking_objections: ['angka beda'] } } : {}) }), VOTE: { vote: { on_draft: 'AGREE' } } })
  const silentFlip = scriptedAgent('b', { PANEL: disagreeThenAgree(null) })
  const explainedFlip = scriptedAgent('c', { PANEL: disagreeThenAgree('K1 terverifikasi') })
  const { result, events } = await council({ panel: [contradictory, silentFlip, explainedFlip], maxRounds: 3 })

  const types = result.flags.map((f) => `${f.agent}:${f.type}:${f.round}`)
  assert.ok(types.includes('a:contradictory_vote:2'))
  assert.ok(types.includes('b:unexplained_flip:3'))
  assert.ok(!types.some((t) => t.startsWith('c:')))
  assert.equal(result.rounds[1].tally.accepted.includes('a'), false) // suara bertentangan dihitung tidak setuju
  assert.ok(events.some((e) => e.type === 'flags'))
})

test('suara akhir: perubahan suara dengan change_reason tidak ditandai', async () => {
  const flipper = (reason) => ({
    PANEL: ({ round }) => ({ position: 'p', ...(round > 1 ? { vote: { on_draft: 'DISAGREE', blocking_objections: ['x'] } } : {}) }),
    VOTE: { vote: { on_draft: 'AGREE', change_reason: reason } }
  })
  const { result } = await council({ panel: [scriptedAgent('a', flipper('draft sudah diperbaiki')), scriptedAgent('b', flipper(''))], maxRounds: 2 })
  assert.equal(result.status, 'unanimous')
  assert.deepEqual(result.flags.map((f) => `${f.agent}:${f.type}`), ['b:unexplained_flip'])
  const voteCall = result.rounds.at(-1)
  assert.equal(voteCall.mode, 'vote')
})

test('pemakaian token dicatat per peran dan per tahap', async () => {
  const panel = ['a', 'b'].map((id) => scriptedAgent(id))
  const { result, events } = await council({ panel })
  const u = result.usage
  assert.equal(u.calls, 6) // frame, 2 panel r1, judge, 2 panel r2
  assert.deepEqual(u.tokens, { input: 600, cacheRead: 120, cacheWrite: 0, output: 60 })
  assert.equal(u.measured, 6)
  assert.equal(u.byRole.moderator.calls, 2)
  assert.equal(u.byRole.a.calls, 2)
  assert.deepEqual(Object.keys(u.byStage).sort(), ['frame', 'judge', 'panel'])
  assert.equal(u.byStage.panel.calls, 4)
  const finished = events.find((e) => e.type === 'agent_finished')
  assert.deepEqual(finished.usage.tokens, { input: 100, cacheRead: 20, cacheWrite: 0, output: 10 })
})
