import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryBlock, memoryFromEvents, memoryFromResult } from '../src/council/memory.js'
import { runCouncil } from '../src/council/protocol.js'
import { buildReport } from '../src/council/report.js'
import { createSession, readMemory } from '../src/store/session.js'
import { scriptedAgent } from './helpers.js'

const IDENTITY = () => 0.999999

const MEMORY = {
  id: 'sidang-lama',
  topic: 'Topik lama',
  question: 'Ide apa yang dipilih?',
  status: 'unanimous',
  finishedAt: '2026-10-01T10:00:00.000Z',
  summary: 'Dipilih CekDulu.',
  draft: 'Kesimpulan lama: bangun CekDulu.',
  claims: [
    { text: 'Laporan penipuan naik', kind: 'fact', source_url: 'https://ojk.test/a', quote: 'naik 20%', verification: { status: 'verified', detail: 'kutipan ditemukan' } }
  ]
}

async function council(opts) {
  const events = []
  const verified = []
  const a = scriptedAgent('a')
  const b = scriptedAgent('b')
  const result = await runCouncil({
    topic: 'Lanjutkan: rencana MVP',
    panel: [a, b],
    moderator: { agent: a, model: 'mod' },
    maxRounds: 2,
    random: IDENTITY,
    emit: (e) => events.push(e),
    verify: async (pending) => {
      verified.push(...pending.map((c) => c.id))
      return new Map(pending.map((c) => [c.id, { status: 'unverifiable', detail: 'uji' }]))
    },
    ...opts
  })
  return { result, events, verified, a, b }
}

test('memori: klaim ✅ lama masuk daftar klaim tanpa dicek ulang, dan muncul di semua prompt', async () => {
  const { result, events, verified, a, b } = await council({ memory: [MEMORY] })
  assert.deepEqual(events[0].memory, [{ id: 'sidang-lama', question: 'Ide apa yang dipilih?', claims: 1 }])
  assert.deepEqual(events[0].memoryClaims.map((c) => [c.id, c.verification.status]), [['K1', 'verified']])

  const k1 = result.claims[0]
  assert.equal(k1.id, 'K1')
  assert.deepEqual(k1.by, ['memori'])
  assert.deepEqual(k1.rounds, [0])
  assert.equal(k1.verification.status, 'verified')
  assert.ok(!verified.includes('K1'))
  assert.ok(verified.length > 0)

  const prompts = [...a.calls, ...b.calls].map((c) => c.prompt)
  assert.ok(prompts.every((p) => p.includes('Memori sidang sebelumnya') && p.includes('Kesimpulan lama: bangun CekDulu.')))
  const blind = b.calls.find((c) => /Tahap: PANEL · Ronde 1/.test(c.prompt)).prompt
  assert.match(blind, /^K1 ✅ fact: Laporan penipuan naik \| https:\/\/ojk\.test\/a \| kutipan: "naik 20%" \| oleh sidang sebelumnya$/m)
  assert.match(blind, /Klaim ✅ dari sidang ini ada di daftar klaim: K1/)
  // Memori ada di bagian statis: sebelum baris "Tahap:".
  assert.ok(blind.indexOf('Memori sidang sebelumnya') < blind.indexOf('Tahap: PANEL'))

  const report = buildReport(result)
  assert.match(report, /\| Melanjutkan sidang \| sidang-lama \(Ide apa yang dipilih\?; klaim ✅: K1\) \|/)
  assert.match(report, /\| K1 \| Laporan penipuan naik \| fact \| .* \| memori sidang sebelumnya \|/)
})

test('memori: tanpa memori, prompt dan event tidak berubah', async () => {
  const { events, a } = await council({})
  assert.equal(events[0].memory, undefined)
  assert.ok(a.calls.every((c) => !c.prompt.includes('Memori sidang')))
  assert.equal(memoryBlock([]), '')
})

test('memoryFromResult dan memoryFromEvents hanya membawa klaim ✅ dan hasil yang sama', async () => {
  const { result, events } = await council({
    verify: async (pending) => new Map(pending.map((c, i) => [c.id, { status: i === 0 ? 'verified' : 'unverifiable', detail: 'uji' }]))
  })
  const fromResult = memoryFromResult(result, { id: 'x' })
  const fromEvents = memoryFromEvents(events, { id: 'x' })
  assert.equal(fromResult.claims.length, 1)
  assert.equal(fromResult.claims[0].verification.status, 'verified')
  for (const key of ['id', 'topic', 'question', 'status', 'summary', 'draft']) assert.equal(fromEvents[key], fromResult[key], key)
  assert.deepEqual(
    fromEvents.claims.map((c) => [c.text, c.source_url, c.verification.status]),
    fromResult.claims.map((c) => [c.text, c.source_url, c.verification.status])
  )
  assert.throws(() => memoryFromEvents(events.slice(0, 3), { id: 'y' }), /belum selesai/)
})

test('readMemory (--lanjut): memory.json, atau disusun dari events.jsonl, atau error yang jelas', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'council-mem-'))
  const { result, events } = await council({})
  const session = createSession({ topic: 'uji', baseDir: base, now: new Date(2026, 9, 3, 8, 0, 0) })
  for (const e of events) session.append(e)
  const fromEvents = readMemory(session.id, { baseDir: base })
  assert.equal(fromEvents.id, session.id)
  assert.equal(fromEvents.status, result.status)

  session.writeMemory({ ...memoryFromResult(result, { id: session.id }), summary: 'dari memory.json' })
  assert.equal(readMemory(session.dir).summary, 'dari memory.json')
  assert.throws(() => readMemory('tidak-ada', { baseDir: base }), /tidak ditemukan/)
})
