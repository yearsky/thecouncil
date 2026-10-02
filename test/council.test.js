import test from 'node:test'
import assert from 'node:assert/strict'
import { accepts, isReached, tally } from '../src/council/consensus.js'
import { extractJson, normalizeVote, validateFrame, validateJudge, validatePanelist } from '../src/council/schema.js'
import { describeResponse, judgePrompt, panelPrompt, votePrompt } from '../src/council/prompts.js'

test('extractJson: JSON polos, berpagar ```json, dan dengan kalimat pembuka', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('Ini jawabanku:\n```json\n{"a":2}\n```\nSemoga membantu'), { a: 2 })
  assert.deepEqual(extractJson('Hasil: {"a":{"b":3}} selesai'), { a: { b: 3 } })
  assert.throws(() => extractJson('tidak ada json'), /bukan objek JSON/)
  assert.throws(() => extractJson('[1,2]'), /bukan objek JSON/)
})

test('validatePanelist merapikan field opsional dan menolak posisi kosong', () => {
  const r = validatePanelist({
    position: '  posisi  ',
    proposals: ['Ide A', { title: 'Ide B', why: 'karena' }, { title: '' }],
    claims: [{ text: 'k1', kind: 'FACT', source_url: 'https://a' }, { text: 'k2', kind: 'ngawur' }, 'k3'],
    critiques: [{ point: 'p', severity: 'Blocking' }, 'kritik bebas']
  })
  assert.equal(r.position, 'posisi')
  assert.deepEqual(r.proposals.map((p) => [p.id, p.title]), [['P1', 'Ide A'], ['P2', 'Ide B']])
  assert.deepEqual(r.claims.map((c) => [c.id, c.kind]), [['C1', 'fact'], ['C2', 'opinion'], ['C3', 'opinion']])
  assert.deepEqual(r.critiques.map((c) => c.severity), ['blocking', 'minor'])
  assert.deepEqual(r.changed_mind, { changed: false, what: '', because: '' })
  assert.equal(r.vote, undefined)
  assert.throws(() => validatePanelist({ position: '' }), /"position" kosong/)
  assert.throws(() => validatePanelist({ position: 'x' }, { expectVote: true }), /"vote" wajib/)
})

test('normalizeVote menerima variasi penulisan dan menolak nilai asing', () => {
  assert.deepEqual(normalizeVote({ on_draft: 'agree with reservations', reservations: 'satu catatan' }), {
    on_draft: 'AGREE_WITH_RESERVATIONS',
    reservations: ['satu catatan'],
    blocking_objections: [],
    change_reason: ''
  })
  assert.throws(() => normalizeVote({ on_draft: 'MAYBE' }), /harus salah satu/)
})

test('validateFrame dan validateJudge', () => {
  assert.deepEqual(validateFrame({ question: 'Q?', criteria: ['a', ''] }), { question: 'Q?', criteria: ['a'], context: '' })
  assert.throws(() => validateFrame({}), /"question" kosong/)
  const j = validateJudge({ draft: 'D', agreements: ['x'] })
  assert.equal(j.summary, 'D')
  assert.deepEqual(j.disagreements, [])
  assert.throws(() => validateJudge({ draft: { teks: 'objek' } }), /"draft" kosong/)
})

test('accepts/tally: keberatan pemblokir membatalkan AGREE, yang gagal dihitung tidak setuju', () => {
  const agree = { on_draft: 'AGREE', reservations: [], blocking_objections: [] }
  const reserved = { on_draft: 'AGREE_WITH_RESERVATIONS', reservations: ['c'], blocking_objections: [] }
  const blocked = { on_draft: 'AGREE', reservations: [], blocking_objections: ['x'] }
  assert.equal(accepts(agree), true)
  assert.equal(accepts(reserved), true)
  assert.equal(accepts(blocked), false)
  assert.equal(accepts(undefined), false)

  assert.equal(tally(['a', 'b'], { a: agree, b: reserved }).status, 'unanimous')
  const t = tally(['a', 'b', 'c'], { a: agree, b: reserved })
  assert.deepEqual([t.status, t.accepted, t.rejected], ['majority', ['a', 'b'], ['c']])
  assert.equal(tally(['a', 'b'], { a: agree, b: blocked }).status, 'no_consensus')

  assert.equal(isReached('unanimous', 'unanimous'), true)
  assert.equal(isReached('majority', 'unanimous'), false)
  assert.equal(isReached('majority', 'majority'), true)
})

test('panelPrompt: ronde blind tanpa suara; ronde kritik memuat draft, jawaban lain, dan format suara', () => {
  const frame = { question: 'Q?', criteria: ['k1'], context: '' }
  const blind = panelPrompt({ frame, round: 1, alias: 'Panelis A', webSearch: true, searchBudget: 3 })
  assert.match(blind, /^Tahap: PANEL · Ronde 1 \(blind\)\nKamu adalah Panelis A\./m)
  assert.match(blind, /maksimal 3 pencarian per ronde/)
  assert.match(blind, /Ini ronde blind/)
  assert.doesNotMatch(blind, /Draft kesimpulan moderator/)

  const other = { position: 'posisi B', proposals: [], claims: [{ id: 'K1', kind: 'fact', text: 'k', source_url: 'https://b' }], cited_claims: ['K2'], critiques: [] }
  const critique = panelPrompt({ frame, round: 2, alias: 'Panelis A', draft: 'DRAFT-1', focus: 'fokus', own: { position: 'posisi A' }, others: [{ label: 'Panelis B', response: other }], webSearch: false })
  assert.match(critique, /DRAFT-1/)
  assert.match(critique, /posisi A/)
  assert.match(critique, /## Panelis B\nPosisi: posisi B/)
  assert.match(critique, /tidak punya akses web/)
  assert.match(critique, /"vote": \{"on_draft"/)
  assert.match(describeResponse('Panelis B', other), /Klaim yang dipakai: K1, K2/)
})

test('draft panjang tidak dipotong saat dinilai panelis (bug dari uji coba sungguhan)', () => {
  const frame = { question: 'Q?', criteria: [], context: '' }
  const draft = `awal ${'x'.repeat(20000)} AKHIR-DRAFT`
  assert.match(panelPrompt({ frame, round: 2, draft }), /AKHIR-DRAFT/)
  assert.match(votePrompt({ frame, draft }), /AKHIR-DRAFT/)
  assert.match(judgePrompt({ frame, round: 2, previousDraft: draft, responses: [] }), /AKHIR-DRAFT/)
  assert.doesNotMatch(panelPrompt({ frame, round: 2, draft }), /\(dipotong\)/)
  assert.match(judgePrompt({ frame, round: 1, responses: [] }), /maksimal sekitar 1\.000 kata/)
})

test('bagian statis prompt identik antar-ronde (bisa dipakai prompt caching)', () => {
  const frame = { question: 'Q?', criteria: ['k1'], context: 'c' }
  const prefix = (p) => p.slice(0, p.indexOf('Tahap:'))
  const r1 = panelPrompt({ frame, round: 1, alias: 'Panelis A', webSearch: true, searchBudget: 3 })
  const r2 = panelPrompt({ frame, round: 2, alias: 'Panelis A', draft: 'D', webSearch: true, searchBudget: 3 })
  assert.ok(prefix(r1).length > 500)
  assert.equal(prefix(r1), prefix(r2))
  const j1 = judgePrompt({ frame, round: 1, responses: [] })
  const j2 = judgePrompt({ frame, round: 2, previousDraft: 'D', responses: [] })
  assert.equal(prefix(j1), prefix(j2))
})

test("devil's advocate hanya untuk panelis yang mendapat giliran", () => {
  const frame = { question: 'Q?', criteria: [], context: '' }
  assert.match(panelPrompt({ frame, round: 2, draft: 'D', devilsAdvocate: true }), /giliran sebagai devil's advocate/)
  assert.doesNotMatch(panelPrompt({ frame, round: 2, draft: 'D' }), /giliran sebagai devil's advocate/)
})

test('votePrompt menyebut suara sebelumnya dan meminta alasan bila berubah', () => {
  const frame = { question: 'Q?', criteria: [], context: '' }
  const p = votePrompt({ frame, draft: 'D', alias: 'Panelis C', previousVote: { on_draft: 'DISAGREE', blocking_objections: ['data lama'] } })
  assert.match(p, /Kamu adalah Panelis C\./)
  assert.match(p, /Suaramu di ronde sebelumnya: DISAGREE \(keberatan: data lama\)/)
  assert.match(p, /"change_reason"/)
})

test('draft panjang dan jawaban panelis tidak dipotong (hanya pengaman 60.000 karakter)', () => {
  const frame = { question: 'Q?', criteria: [], context: '' }
  const long = `awal ${'y'.repeat(30000)} AKHIR-POSISI`
  const p = panelPrompt({ frame, round: 2, draft: 'D', others: [{ label: 'Panelis B', response: { position: long, proposals: [], claims: [], critiques: [] } }] })
  assert.match(p, /AKHIR-POSISI/)
  assert.doesNotMatch(p, /dipotong/)
})
