// Tahap riset (docs/PLAN.md §19): literatur → peneliti → verifikasi → debat yang memakai hasilnya;
// lensa panelis; daftar jawaban klise; catatan pencarian web.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RESEARCH_AGENT, runCouncil, searchSummary } from '../src/council/protocol.js'
import { RESEARCHER_SYSTEM } from '../src/council/prompts.js'
import { createRun, readEvents, readMeta, runSlice } from '../src/cloud/runner.js'
import { memoryKv } from '../src/store/kv.js'
import { FAKE_PAPER, scriptedAgent } from './helpers.js'

const RESEARCH = { enabled: true, maxQueries: 6, searchBudget: 6 }
const FRAME = { question: 'Ide apa?', criteria: ['tidak klise'], context: '', obvious: ['chatbot WhatsApp UMKM'], queries: ['smallholder credit', 'kredit petani'] }

async function council({ panel, moderator = panel[0], ...opts }) {
  const events = []
  const result = await runCouncil({
    topic: 'Ide hackathon',
    panel,
    moderator: { agent: moderator, model: 'mod-model' },
    emit: (e) => events.push(e),
    clock: () => new Date('2026-10-03T08:00:00Z'),
    random: () => 0.999999, // a = Panelis A, b = Panelis B, …
    ...opts
  })
  return { result, events, types: events.map((e) => e.type) }
}

test('riset: literatur dicari dari query FRAME, peneliti menulis insight, lalu debat memakainya', async () => {
  const queries = []
  const literatureSearch = async (q) => {
    queries.push(q)
    return { papers: [FAKE_PAPER], errors: [], stats: { semanticscholar: { queries: 2, results: 1 } } }
  }
  const verified = []
  const verify = async (pending) => {
    verified.push(...pending.map((c) => c.id))
    return new Map(pending.map((c) => [c.id, { status: 'verified', detail: 'uji' }]))
  }
  const mod = scriptedAgent('a', { FRAME }, { webSearch: true, searches: 4 })
  const panel = [mod, scriptedAgent('b')]
  const { result, events, types } = await council({ panel, research: RESEARCH, literatureSearch, verify, lenses: true })

  assert.deepEqual(queries, [['smallholder credit', 'kredit petani']])
  assert.deepEqual(types.slice(0, 6), ['session_started', 'framed', 'literature', 'researched', 'verified', 'round_started'])
  assert.equal(events[0].research, true)
  assert.deepEqual(events[1].obvious, ['chatbot WhatsApp UMKM'])

  // Peneliti = agen moderator, dengan system prompt peneliti, model moderator, dan batas pencarian tahap riset.
  const call = mod.calls.find((c) => /^Tahap: RESEARCH/m.test(c.prompt))
  assert.equal(call.system, RESEARCHER_SYSTEM)
  assert.equal(call.model, 'mod-model')
  assert.equal(call.webSearch, true)
  assert.equal(call.searchUses, 6)
  assert.match(call.prompt, /^S1 · Credit scoring for smallholder farmers using satellite data \(2024, World Development, 40 sitasi\)/m)
  assert.match(call.prompt, /Jawaban klise yang harus dilampaui[^\n]*\n- chatbot WhatsApp UMKM/)

  // Klaim dengan source_url "S1" dipetakan ke URL paper dan dicek ke abstraknya tanpa membuka halaman.
  const researched = events.find((e) => e.type === 'researched')
  const [web, fromPaper] = researched.claims
  assert.equal(fromPaper.source_url, FAKE_PAPER.url)
  assert.equal(fromPaper.source, 'S1')
  assert.deepEqual(researched.insights[1].sources, [web.id], 'C1 → ID klaim global')
  assert.deepEqual(researched.search, { requests: 4, urls: ['https://a.cari/1', 'https://a.cari/2', 'https://a.cari/3', 'https://a.cari/4'], results: 4 })
  const v0 = events.find((e) => e.type === 'verified')
  assert.equal(v0.round, 0)
  assert.deepEqual(
    v0.claims.find((c) => c.id === fromPaper.id),
    { id: fromPaper.id, status: 'verified', detail: 'kutipan ada di abstrak S1', source_url: FAKE_PAPER.url, source: 'S1' }
  )
  assert.ok(!verified.includes(fromPaper.id), 'tidak dikirim ke verifier jaringan')
  assert.ok(verified.includes(web.id))
  assert.ok(result.claims.find((c) => c.id === fromPaper.id).by.includes(RESEARCH_AGENT))

  // Ronde 1: literatur, insight, klise, dan lensa ada di prompt; bagian statis sama untuk tiap panelis.
  const r1 = panel.map((p) => p.calls.find((c) => /^Tahap: PANEL · Ronde 1/m.test(c.prompt)).prompt)
  for (const prompt of r1) {
    assert.match(prompt, /I1: temuan dari paper \(sumber: S1\)/)
    assert.match(prompt, /Mulai dari hasil riset dan lensamu/)
  }
  assert.match(r1[0], /Lensa berpikirmu: Peneliti/)
  assert.match(r1[1], /Lensa berpikirmu: Orang dalam industri/)
  const staticPart = (p) => p.slice(0, p.indexOf('Aturan panelis'))
  assert.equal(staticPart(r1[0]), staticPart(r1[1]))
  assert.deepEqual(
    events[0].panel.map((p) => p.lens),
    ['Peneliti', 'Orang dalam industri']
  )
  assert.equal(result.research.literature[0].id, 'S1')
  assert.equal(result.research.insights.length, 2)
  assert.equal(result.usage.byStage.research.calls, 1)
  assert.equal(result.usage.byStage.research.searches, 4)
})

test('riset gagal tidak menghentikan sidang; error literatur jadi satu peringatan', async () => {
  const literatureSearch = async () => ({ papers: [], errors: [{ source: 'openalex', query: 'q', message: 'HTTP 429 (dibatasi)' }, { source: 'openalex', query: 'q2', message: 'HTTP 429 (dibatasi)' }], stats: {} })
  const mod = scriptedAgent('a', { FRAME, RESEARCH: new Error('HTTP 503') })
  const { result, events } = await council({ panel: [mod], research: RESEARCH, literatureSearch })
  const warnings = events.filter((e) => e.type === 'warning')
  assert.deepEqual(
    warnings.map((w) => w.stage),
    ['literature', 'research']
  )
  assert.match(warnings[0].message, /openalex: HTTP 429 \(dibatasi\)\)/)
  assert.equal(result.status, 'unanimous')
  assert.deepEqual(result.research.insights, [])
})

test('tanpa riset: tidak ada tahap riset, prompt tetap meminta usulan yang tidak klise', async () => {
  const panel = [scriptedAgent('a')]
  const { types } = await council({ panel })
  assert.ok(!types.includes('literature') && !types.includes('researched'))
  assert.ok(!panel[0].calls.some((c) => /^Tahap: RESEARCH/m.test(c.prompt)))
  const r1 = panel[0].calls.find((c) => /^Tahap: PANEL · Ronde 1/m.test(c.prompt)).prompt
  assert.match(r1, /bukan dari ide yang sudah umum/)
  assert.doesNotMatch(r1, /Lensa berpikirmu/)
  const frame = panel[0].calls.find((c) => /^Tahap: FRAME/m.test(c.prompt)).prompt
  assert.doesNotMatch(frame, /"queries"/)
})

test('pencarian web panelis tercatat di agent_finished; 0 pencarian tetap terlihat', async () => {
  const a = scriptedAgent('a', {}, { webSearch: true, searches: 2 })
  const b = scriptedAgent('b', {}, { webSearch: true, searches: 0 })
  const c = scriptedAgent('c')
  const { events, result } = await council({ panel: [a, b, c], maxRounds: 1 })
  const fin = Object.fromEntries(events.filter((e) => e.type === 'agent_finished' && e.round === 1).map((e) => [e.agent, e.search]))
  assert.deepEqual(fin.a, { requests: 2, urls: ['https://a.cari/1', 'https://a.cari/2'], results: 2 })
  assert.deepEqual(fin.b, { requests: 0, urls: [], results: 0 })
  assert.equal(fin.c, undefined, 'tanpa web search, tanpa catatan')
  assert.equal(result.usage.byRole.a.searches, 2)
  assert.equal(searchSummary([{ web: true, searches: 1, searchFallback: 'HTTP 400' }]).fallback, 'HTTP 400')
})

test('usulan menyimpan dasar, alasan tidak umum, dan why now', async () => {
  const a = scriptedAgent('a', {
    PANEL: ({ round }) => ({
      position: 'p',
      proposals: [{ title: 'Skor kredit satelit', why: 'w', basis: ['i1', 'S1', 'x9'], non_obvious: 'bank belum pakai', why_now: 'citra gratis' }],
      ...(round > 1 ? { vote: { on_draft: 'AGREE' } } : {})
    })
  })
  const b = scriptedAgent('b')
  const { events } = await council({ panel: [a, b] })
  const p = events.find((e) => e.type === 'agent_finished' && e.agent === 'a').response.proposals[0]
  assert.deepEqual(p, { id: 'P1', title: 'Skor kredit satelit', why: 'w', basis: ['I1', 'S1'], non_obvious: 'bank belum pakai', why_now: 'citra gratis' })
  const judge = a.calls.find((c) => /^Tahap: JUDGE/m.test(c.prompt)).prompt
  assert.match(judge, /- P1: Skor kredit satelit — w \[dasar: I1, S1\]\n  Tidak umum karena: bank belum pakai\n  Kenapa sekarang: citra gratis/)
  assert.match(judge, /Nilai kebaruan, bukan hanya kelayakan/)
})

test('cloud: pencarian literatur dijurnal, jadi tidak diulang saat sidang dicicil', async () => {
  const kv = memoryKv()
  const config = {
    moderator: { agent: 'a', model: 'mod' },
    panel: ['a', 'b'],
    maxRounds: 2,
    consensus: 'unanimous',
    web: false,
    verify: true,
    lenses: true,
    research: { enabled: true, maxQueries: 4, searchBudget: 5 },
    effort: {},
    agents: {}
  }
  const meta = await createRun(kv, { topic: 'Ide', config, seed: 7 })
  let searches = 0
  const makeLiterature = () => async () => {
    searches++
    return { papers: [FAKE_PAPER], errors: [], stats: {} }
  }
  const makeAgents = () => ({ a: scriptedAgent('a', { FRAME }), b: scriptedAgent('b') })
  const makeVerifier = () => async (pending) => new Map(pending.map((c) => [c.id, { status: 'unverifiable', detail: 'uji' }]))
  // Jam maju 1 tiap dibaca; jendela kecil memaksa banyak slice.
  const clock = { t: 0 }
  const states = []
  for (let i = 0; i < 40; i++) {
    const r = await runSlice(kv, meta.id, { makeAgents, makeVerifier, makeLiterature, startWindowMs: 3, now: () => clock.t++ })
    states.push(r.state)
    if (r.state !== 'paused') break
  }
  assert.equal(states.at(-1), 'finished')
  assert.ok(states.length > 2, `dicicil (${states.length} slice)`)
  assert.equal(searches, 1)
  const events = await readEvents(kv, meta.id)
  assert.equal(events.filter((e) => e.type === 'literature').length, 1)
  assert.equal(events.filter((e) => e.type === 'researched').length, 1)
  assert.equal((await readMeta(kv, meta.id)).status, 'finished')
  assert.deepEqual(
    events.find((e) => e.type === 'session_started').panel.map((p) => p.lens).sort(),
    ['Orang dalam industri', 'Peneliti']
  )
})
