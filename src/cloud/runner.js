// Menjalankan sidang secara dicicil di server (docs/PLAN.md §18). Semua status disimpan di KV:
//   run:{id}:meta     status sidang, config (tanpa rahasia), seed, memori yang dibawa
//   run:{id}:events   event sidang (JSON per elemen, urut), masing-masing dengan `seq` dan `id` tetap
//   run:{id}:journal  jurnal panggilan AI (src/cloud/journal.js)
//   run:{id}:lock     hanya satu slice yang boleh berjalan
//   run:{id}:cancel   permintaan batal
//   run:{id}:report   laporan Markdown setelah selesai
//   memory:{id}       memori sidang untuk "Lanjutkan dari…"
//   runs              daftar ID sidang, terbaru di depan

import crypto from 'node:crypto'
import { createAgents } from '../agents/index.js'
import { memoryFromResult } from '../council/memory.js'
import { runCouncil } from '../council/protocol.js'
import { buildReport } from '../council/report.js'
import { createVerifier } from '../evidence/verify.js'
import { slugify, stamp } from '../store/session.js'
import { createGate, createReplay, kvJournal } from './journal.js'
import { mulberry32, newSeed } from './seed.js'

export const runKey = (id, part) => `run:${id}:${part}`
export const memoryKey = (id) => `memory:${id}`

// ID tetap per kejadian. Saat sidang diputar ulang, event yang sama punya ID yang sama dan tidak disimpan lagi.
// Urutan event dari panggilan paralel bisa berbeda saat diputar ulang, jadi nomor urut tidak bisa dipakai.
export function eventId(e) {
  return [e.type, e.round ?? '', e.agent ?? '', e.stage ?? ''].join(':')
}

export function makeRunId(topic, now = new Date()) {
  return `${stamp(now)}_${slugify(topic, 30)}_${crypto.randomBytes(2).toString('hex')}`
}

export async function readMeta(kv, id) {
  const raw = await kv.get(runKey(id, 'meta'))
  return raw ? JSON.parse(raw) : null
}

export async function writeMeta(kv, meta) {
  await kv.set(runKey(meta.id, 'meta'), JSON.stringify(meta))
}

export async function readEvents(kv, id, after = 0) {
  return (await kv.lrange(runKey(id, 'events'), after, -1)).map((raw) => JSON.parse(raw))
}

export async function readMemory(kv, id) {
  const raw = await kv.get(memoryKey(id))
  return raw ? JSON.parse(raw) : null
}

export async function createRun(kv, { topic, config, memory = [], now = new Date(), seed = newSeed(), id = makeRunId(topic, now) }) {
  const meta = { id, topic, createdAt: now.toISOString(), seed, status: 'running', slices: 0, config, memory }
  await writeMeta(kv, meta)
  await kv.lpush('runs', id)
  return meta
}

// Satu slice: putar ulang sidang dari jurnal dan lanjutkan sampai selesai atau sampai waktu slice habis.
// Hasil `state`: finished | paused | cancelled | error | busy (slice lain sedang jalan) | missing | <status akhir>.
export async function runSlice(
  kv,
  runId,
  { makeAgents = (config) => createAgents(config), makeVerifier = () => createVerifier(), startWindowMs = Infinity, lockTtlSec = 330, now = Date.now, onEvent } = {}
) {
  const token = crypto.randomUUID()
  if (!(await kv.set(runKey(runId, 'lock'), token, { nx: true, ex: lockTtlSec }))) return { state: 'busy', events: [] }
  try {
    const meta = await readMeta(kv, runId)
    if (!meta) return { state: 'missing', events: [] }
    if (meta.status !== 'running') return { state: meta.status, events: [] }
    meta.slices += 1
    meta.lastSliceAt = new Date(now()).toISOString()
    await writeMeta(kv, meta)

    const existing = await kv.lrange(runKey(runId, 'events'), 0, -1)
    const ids = new Set(existing.map((raw) => JSON.parse(raw).id))
    let seq = existing.length
    let saving = Promise.resolve()
    const appended = []
    const emit = (event) => {
      const id = eventId(event)
      if (ids.has(id)) return
      ids.add(id)
      const stored = { seq: seq++, id, ...event }
      appended.push(stored)
      onEvent?.(stored)
      saving = saving.then(() => kv.rpush(runKey(runId, 'events'), JSON.stringify(stored)))
    }

    const gate = createGate({
      startAllowedUntil: now() + startWindowMs,
      now,
      isCancelled: async () => Boolean(await kv.get(runKey(runId, 'cancel')))
    })
    const replay = createReplay({ journal: kvJournal(kv, runId), gate, seqBase: meta.slices * 1e6 })
    const { config } = meta
    const agents = Object.fromEntries(Object.entries(makeAgents(config)).map(([id, agent]) => [id, replay.agent(agent)]))

    let outcome
    try {
      await runCouncil({
        topic: meta.topic,
        panel: config.panel.map((id) => agents[id]),
        moderator: { agent: agents[config.moderator.agent], model: config.moderator.model || undefined },
        maxRounds: config.maxRounds,
        consensus: config.consensus,
        web: config.web,
        searchBudget: config.searchBudget,
        devilsAdvocate: config.devilsAdvocate,
        effort: config.effort,
        verify: config.verify ? replay.verifier(makeVerifier()) : null,
        memory: meta.memory || [],
        random: mulberry32(meta.seed),
        startedAt: meta.createdAt,
        emit,
        finalize: async (result) => {
          await kv.set(runKey(runId, 'report'), buildReport(result))
          await kv.set(memoryKey(runId), JSON.stringify(memoryFromResult(result, { id: runId })))
          return { run: runId }
        }
      })
      outcome = 'finished'
    } catch (err) {
      if (err.isYield) outcome = err.cancelled ? 'cancelled' : 'paused'
      else {
        outcome = 'error'
        meta.error = err.message
      }
    }

    const writeErrors = await replay.settle()
    // Beri kesempatan sidang mencatat event dari panggilan yang baru selesai (agent_finished) sebelum event penutup.
    await new Promise((resolve) => setImmediate(resolve))
    if (writeErrors.length && outcome !== 'finished') {
      outcome = 'error'
      meta.error = `jurnal gagal disimpan: ${writeErrors[0]}`
    }
    const ts = new Date(now()).toISOString()
    if (outcome === 'cancelled') emit({ type: 'cancelled', ts, message: 'Sidang dibatalkan.' })
    if (outcome === 'error') emit({ type: 'warning', ts, stage: 'run', message: `Sidang berhenti karena error: ${meta.error}` })
    await saving

    if (outcome !== 'paused') {
      meta.status = outcome
      meta.finishedAt = ts
      if ((await kv.get('active')) === runId) await kv.del('active')
    }
    await writeMeta(kv, meta)
    return { state: outcome, events: appended }
  } finally {
    if ((await kv.get(runKey(runId, 'lock'))) === token) await kv.del(runKey(runId, 'lock'))
  }
}
