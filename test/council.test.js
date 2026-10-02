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
    blocking_objections: []
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
  const blind = panelPrompt({ frame, round: 1, webSearch: true })
  assert.match(blind, /^Tahap: PANEL · Ronde 1 \(blind\)/)
  assert.match(blind, /Gunakan pencarian web/)
  assert.doesNotMatch(blind, /"vote"/)

  const other = { position: 'posisi B', proposals: [], claims: [{ id: 'C1', kind: 'fact', text: 'k', source_url: 'https://b' }], critiques: [] }
  const critique = panelPrompt({ frame, round: 2, draft: 'DRAFT-1', focus: 'fokus', own: { position: 'posisi A' }, others: [{ label: 'B', response: other }], webSearch: false })
  assert.match(critique, /DRAFT-1/)
  assert.match(critique, /posisi A/)
  assert.match(critique, /## B\nPosisi: posisi B/)
  assert.match(critique, /tidak punya akses web/)
  assert.match(critique, /"vote": \{"on_draft"/)
  assert.match(describeResponse('B', other), /\(sumber: https:\/\/b\)/)
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
