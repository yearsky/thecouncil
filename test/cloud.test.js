import test from 'node:test'
import assert from 'node:assert/strict'
import { createRun, eventId, readEvents, readMemory, readMeta, runKey, runSlice, writeMeta } from '../src/cloud/runner.js'
import { createGate, createReplay } from '../src/cloud/journal.js'
import { mulberry32 } from '../src/cloud/seed.js'
import { memoryKv } from '../src/store/kv.js'
import { scriptedAgent } from './helpers.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CONFIG = {
  moderator: { agent: 'a', model: 'mod' },
  panel: ['a', 'b', 'c'],
  maxRounds: 3,
  consensus: 'unanimous',
  web: true,
  verify: true,
  searchBudget: 3,
  devilsAdvocate: true,
  effort: {},
  agents: {}
}

// Panelis dengan klaim berbeda per ronde, dan "c" baru setuju di ronde 3, supaya sidang cukup panjang.
const SCRIPT = (id) => ({
  PANEL: ({ round }) => ({
    position: `posisi ${id} r${round}`,
    claims: [
      { text: `klaim ${id} r${round}`, kind: 'fact', source_url: `https://${id}.test/${round}`, quote: 'q' },
      { text: 'klaim bersama', kind: 'fact', source_url: 'https://bersama.test', quote: 'q' }
    ],
    ...(round > 1 ? { vote: id === 'c' && round < 3 ? { on_draft: 'DISAGREE', blocking_objections: ['kurang data'] } : { on_draft: 'AGREE' } } : {})
  })
})

// Lingkungan uji: agen dengan jeda acak (urutan selesai berbeda tiap slice), jam palsu, dan penghitung panggilan.
function harness({ seed = 1, failOnce, jitter = true } = {}) {
  const clock = { t: 0 }
  const live = []
  let delays = mulberry32(seed)
  let failed = false
  const makeAgents = () =>
    Object.fromEntries(
      ['a', 'b', 'c'].map((id) => {
        const inner = scriptedAgent(id, SCRIPT(id))
        return [
          id,
          {
            ...inner,
            async ask(req) {
              live.push(id)
              await sleep(jitter ? Math.floor(delays() * 8) : 0)
              if (failOnce === id && !failed && /Tahap: PANEL · Ronde 1/.test(req.prompt)) {
                failed = true
                throw new Error('HTTP 503 sementara')
              }
              return inner.ask(req)
            }
          }
        ]
      })
    )
  const verifyCalls = []
  const makeVerifier = () => async (pending) => {
    verifyCalls.push(pending.map((c) => c.id))
    await sleep(jitter ? Math.floor(delays() * 5) : 0)
    return new Map(pending.map((c) => [c.id, { status: c.source_url.includes('bersama') ? 'verified' : 'unverifiable', detail: 'uji' }]))
  }
  return {
    clock,
    live,
    verifyCalls,
    reseed: (s) => (delays = mulberry32(s)),
    // Jam maju 1 setiap kali dibaca, jadi gerbang waktu bisa menjeda di tengah panggilan paralel.
    opts: (extra = {}) => ({ makeAgents, makeVerifier, now: () => clock.t++, ...extra })
  }
}

// Bagian event yang harus identik antara sidang tanpa jeda dan sidang yang dicicil.
function essence(events) {
  return events
    .map(({ seq, ts, ms, usage, ...rest }) => rest)
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

const normalizeReport = (md) =>
  md
    .split('\n')
    .filter((l) => !/dtk|\| Waktu \||Token|\| Peran \||\| Tahap \||^\|---|^\| (Moderator|[A-C]) \(|Panggilan AI/.test(l))
    .join('\n')

async function finishInSlices(kv, id, h, { window, maxSlices = 50 }) {
  const states = []
  for (let i = 0; i < maxSlices; i++) {
    h.reseed(100 + i) // urutan selesai panggilan paralel berbeda di tiap slice
    const r = await runSlice(kv, id, h.opts({ startWindowMs: window }))
    states.push(r.state)
    if (r.state !== 'paused') return states
  }
  throw new Error('sidang tidak selesai')
}

test('eventId tetap untuk kejadian yang sama', () => {
  assert.equal(eventId({ type: 'agent_finished', round: 2, agent: 'b', ts: 'x' }), 'agent_finished:2:b:')
  assert.equal(eventId({ type: 'warning', stage: 'verify', round: 1 }), 'warning:1::verify')
  assert.equal(eventId({ type: 'session_started' }), 'session_started:::')
})

// Putar ulang sidang yang sudah selesai dari jurnalnya saja, dengan pencarian jurnal yang lambatnya acak.
// Tidak boleh ada panggilan AI baru, dan event yang dihasilkan harus sama dengan yang tersimpan.
async function auditReplay(kv, id) {
  const saved = await readEvents(kv, id)
  await kv.del(runKey(id, 'events'))
  const meta = await readMeta(kv, id)
  await writeMeta(kv, { ...meta, status: 'running' })
  const hget = kv.hget.bind(kv)
  const jitter = mulberry32(999)
  kv.hget = async (...args) => {
    await sleep(Math.floor(jitter() * 6))
    return hget(...args)
  }
  const calls = []
  const makeAgents = () => Object.fromEntries(['a', 'b', 'c'].map((x) => [x, { id: x, label: x.toUpperCase(), model: `${x}-model`, capabilities: { webSearch: false }, ask: async () => calls.push(x) }]))
  const r = await runSlice(kv, id, { makeAgents, makeVerifier: () => async () => calls.push('verify') })
  kv.hget = hget
  return { saved, replayed: await readEvents(kv, id), calls, state: r.state }
}

test('sidang yang dicicil dalam banyak slice: konsisten saat diputar ulang, tanpa panggilan ganda', async () => {
  const kv = memoryKv()
  const h = harness()
  await createRun(kv, { id: 'r', topic: 'Topik uji', config: CONFIG, seed: 42 })
  // Jendela sempit: tiap slice hanya boleh memulai beberapa panggilan baru, kadang di tengah ronde paralel.
  const states = await finishInSlices(kv, 'r', h, { window: 2 })
  assert.ok(states.length > 5, `hanya ${states.length} slice`)
  assert.equal(states.at(-1), 'finished')

  const events = await readEvents(kv, 'r')
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i))
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'event tersimpan dua kali')
  const finished = events.at(-1)
  assert.equal(finished.type, 'finished')
  assert.equal(finished.status, 'unanimous')
  assert.equal(finished.run, 'r')
  // ID klaim di jawaban yang tersimpan cocok dengan daftar klaim akhir (memori + laporan dibuat dari daftar itu).
  const memory = await readMemory(kv, 'r')
  assert.deepEqual(memory.claims.map((c) => c.source_url), ['https://bersama.test'])
  assert.match(await kv.get(runKey('r', 'report')), /# The Council — Q\?/)

  const meta = await readMeta(kv, 'r')
  assert.equal(meta.status, 'finished')
  assert.equal(meta.slices, states.length)
  assert.equal(await kv.exists(runKey('r', 'lock')), false)
  assert.equal((await runSlice(kv, 'r', h.opts())).state, 'finished') // tidak dijalankan lagi

  const audit = await auditReplay(kv, 'r')
  assert.equal(audit.state, 'finished')
  assert.deepEqual(audit.calls, [])
  assert.deepEqual(essence(audit.replayed), essence(audit.saved))
})

test('dicicil atau tidak, hasilnya sama kalau urutan selesai panggilannya sama', async () => {
  const now = new Date('2026-10-03T01:00:00Z')
  const fixed = { seed: 0 } // tanpa jeda acak: panggilan paralel selesai sesuai urutan panel
  const refKv = memoryKv()
  const ref = harness({ ...fixed, jitter: false })
  await createRun(refKv, { id: 'r', topic: 'Topik uji', config: CONFIG, now, seed: 42 })
  assert.equal((await runSlice(refKv, 'r', ref.opts())).state, 'finished')

  const kv = memoryKv()
  const h = harness({ ...fixed, jitter: false })
  await createRun(kv, { id: 'r', topic: 'Topik uji', config: CONFIG, now, seed: 42 })
  const states = await finishInSlices(kv, 'r', h, { window: 2 })
  assert.ok(states.length > 5)
  assert.deepEqual(essence(await readEvents(kv, 'r')), essence(await readEvents(refKv, 'r')))
  assert.equal(h.live.length, ref.live.length)
  assert.equal(h.verifyCalls.length, ref.verifyCalls.length)
  const withoutTime = ({ finishedAt, ...m }) => m
  assert.deepEqual(withoutTime(await readMemory(kv, 'r')), withoutTime(await readMemory(refKv, 'r')))
  assert.equal(normalizeReport(await kv.get(runKey('r', 'report'))), normalizeReport(await refKv.get(runKey('r', 'report'))))
})

test('panggilan gagal ikut dijurnal: saat diputar ulang tetap gagal, tidak dipanggil lagi', async () => {
  const kv = memoryKv()
  const h = harness({ failOnce: 'b' })
  await createRun(kv, { id: 'x', topic: 'Topik uji', config: CONFIG, seed: 7 })
  await finishInSlices(kv, 'x', h, { window: 2.5 })
  const events = await readEvents(kv, 'x')
  const failed = events.filter((e) => e.type === 'agent_failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].error, /HTTP 503 sementara/)
  assert.equal(events.at(-1).type, 'finished')
})

test('slice kedua tidak bisa berjalan bersamaan; batal menghentikan sidang di panggilan berikutnya', async () => {
  const kv = memoryKv()
  const h = harness()
  await createRun(kv, { id: 'y', topic: 'Topik uji', config: CONFIG, seed: 3 })
  await kv.set(runKey('y', 'lock'), 'slice-lain')
  assert.equal((await runSlice(kv, 'y', h.opts())).state, 'busy')
  await kv.del(runKey('y', 'lock'))

  assert.equal((await runSlice(kv, 'y', h.opts({ startWindowMs: 2.5 }))).state, 'paused')
  await kv.set('active', 'y')
  await kv.set(runKey('y', 'cancel'), '1')
  const r = await runSlice(kv, 'y', h.opts())
  assert.equal(r.state, 'cancelled')
  assert.equal(r.events.at(-1).type, 'cancelled')
  const meta = await readMeta(kv, 'y')
  assert.equal(meta.status, 'cancelled')
  assert.equal(await kv.get('active'), null)
  assert.equal((await runSlice(kv, 'y', h.opts())).state, 'cancelled')
  assert.equal((await runSlice(kv, 'tidak-ada', h.opts())).state, 'missing')
})

test('jurnal yang gagal disimpan menghentikan sidang dengan pesan jelas', async () => {
  const kv = memoryKv()
  const h = harness()
  await createRun(kv, { id: 'z', topic: 'Topik uji', config: CONFIG, seed: 3 })
  kv.hset = async () => {
    throw new Error('Redis penuh')
  }
  const r = await runSlice(kv, 'z', h.opts({ startWindowMs: 2.5 }))
  assert.equal(r.state, 'error')
  const meta = await readMeta(kv, 'z')
  assert.match(meta.error, /jurnal gagal disimpan: Redis penuh/)
  assert.match(r.events.at(-1).message, /Sidang berhenti karena error/)
})

test('replay: hasil jurnal dikembalikan menurut urutan selesai aslinya', async () => {
  const store = new Map()
  const journal = {
    get: async (k) => {
      await sleep(k.includes('lambat') ? 10 : 0)
      return store.get(k) || null
    },
    put: async (k, v) => store.set(k, v)
  }
  const order = []
  const agent = (id) => ({ id, model: 'm', ask: async () => ({ text: id }) })
  // Slice 1: "lambat" selesai lebih dulu (seq lebih kecil).
  const r1 = createReplay({ journal, gate: createGate(), seqBase: 1e6 })
  await r1.agent(agent('lambat')).ask({ prompt: 'p' })
  await r1.agent(agent('cepat')).ask({ prompt: 'p' })
  await r1.settle()
  // Slice 2: pencarian jurnal "lambat" lebih lama, tapi hasilnya tetap dikembalikan lebih dulu.
  const r2 = createReplay({ journal, gate: createGate({ startAllowedUntil: -1 }), seqBase: 2e6 })
  await Promise.all(['cepat', 'lambat'].map((id) => r2.agent(agent(id)).ask({ prompt: 'p' }).then((r) => order.push(r.text))))
  assert.deepEqual(order, ['lambat', 'cepat'])
  // Panggilan baru di luar jendela waktu → sinyal jeda.
  await assert.rejects(r2.agent(agent('baru')).ask({ prompt: 'p' }), (err) => err.isYield === true)
})

test('memoryKv: NX, kedaluwarsa, daftar, dan hash seperti Redis', async () => {
  let t = 0
  const kv = memoryKv({ now: () => t })
  assert.equal(await kv.set('k', 'v', { nx: true, ex: 10 }), true)
  assert.equal(await kv.set('k', 'w', { nx: true }), false)
  t = 10000
  assert.equal(await kv.get('k'), null)
  assert.equal(await kv.incr('n'), 1)
  assert.equal(await kv.incr('n'), 2)
  await kv.rpush('l', 'a', 'b', 'c')
  await kv.lpush('l', 'x', 'y')
  assert.deepEqual(await kv.lrange('l', 0, -1), ['y', 'x', 'a', 'b', 'c'])
  assert.deepEqual(await kv.lrange('l', 3, -1), ['b', 'c'])
  assert.deepEqual(await kv.lrange('l', 0, 1), ['y', 'x'])
  assert.deepEqual(await kv.lrange('l', 9, -1), [])
  assert.equal(await kv.llen('l'), 5)
  await kv.hset('h', 'f', '1')
  assert.equal(await kv.hget('h', 'f'), '1')
  assert.equal(await kv.hget('h', 'g'), null)
})

test('upstashKv mengirim perintah Redis sebagai array JSON dengan token', async (t) => {
  const http = await import('node:http')
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const args = JSON.parse(body)
      seen.push({ auth: req.headers.authorization, args })
      res.writeHead(args[0] === 'BOOM' ? 400 : 200, { 'Content-Type': 'application/json' })
      const result = { SET: args.includes('NX') ? null : 'OK', GET: 'nilai', EXISTS: 1, LRANGE: ['a'], BOOM: undefined }[args[0]]
      res.end(JSON.stringify(args[0] === 'BOOM' ? { error: 'ERR unknown command' } : { result: result ?? 1 }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { upstashKv, upstashEnv } = await import('../src/store/kv.js')
  const kv = upstashKv({ url: `http://127.0.0.1:${server.address().port}/`, token: 'tok' })
  assert.equal(await kv.set('k', 'v', { ex: 5 }), true)
  assert.equal(await kv.set('k', 'v', { nx: true, ex: 5 }), false)
  assert.equal(await kv.get('k'), 'nilai')
  assert.equal(await kv.exists('k'), true)
  assert.deepEqual(await kv.lrange('l', 0, -1), ['a'])
  assert.deepEqual(seen[0], { auth: 'Bearer tok', args: ['SET', 'k', 'v', 'EX', '5'] })
  assert.deepEqual(seen[1].args, ['SET', 'k', 'v', 'NX', 'EX', '5'])
  assert.deepEqual(seen.at(-1).args, ['LRANGE', 'l', '0', '-1'])
  await assert.rejects(kv.cmd('BOOM'), /Redis BOOM gagal \(HTTP 400\): ERR unknown command/)
  assert.deepEqual(upstashEnv({ KV_REST_API_URL: 'u', KV_REST_API_TOKEN: 't' }), { url: 'u', token: 't' })
  assert.deepEqual(upstashEnv({ UPSTASH_REDIS_REST_URL: 'u2', UPSTASH_REDIS_REST_TOKEN: 't2' }), { url: 'u2', token: 't2' })
  assert.equal(upstashEnv({}), null)
})
