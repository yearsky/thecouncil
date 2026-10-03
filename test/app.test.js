import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, routeOf } from '../src/cloud/app.js'
import { CLOUD_CONFIG, cloudConfig, runConfigErrors } from '../src/cloud/config.js'
import { parseActive, readMeta } from '../src/cloud/runner.js'
import { mergeConfig, DEFAULT_CONFIG } from '../src/config.js'
import { startServer } from '../src/server.js'
import { memoryKv } from '../src/store/kv.js'
import { FAKE_PAPER, scriptedAgent } from './helpers.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const api = (agentModel = 'm-flash') => ({ type: 'anthropic-compatible', label: 'DS', model: agentModel, apiKeyEnv: 'X' })
const CONFIG = mergeConfig(DEFAULT_CONFIG, {
  moderator: { agent: 'p', model: '' },
  panel: ['p', 'q'],
  maxRounds: 2,
  agents: { p: { ...api('m-pro'), label: 'DS Pro' }, q: { ...api(), label: 'DS Flash' } }
})

function setup({ env = { COUNCIL_PASSWORD: 'rahasia', COUNCIL_API_TOKEN: 'tok-bot' }, limits = {}, script = {}, ...opts } = {}) {
  const kv = memoryKv()
  const tasks = []
  const logs = []
  const makeAgents = (config) =>
    Object.fromEntries(
      [...new Set([config.moderator.agent, ...config.panel])].map((id) => {
        const agent = scriptedAgent(id, script)
        return [id, { ...agent, label: config.agents[id].label, model: config.agents[id].model, timeoutMs: config.agents[id].timeoutMs, listModels: async () => ['m-pro', 'm-flash'] }]
      })
    )
  const app = createApp({
    kv,
    config: CONFIG,
    env,
    waitUntil: (p) => tasks.push(p),
    makeAgents,
    makeVerifier: () => async (pending) => new Map(pending.map((c) => [c.id, { status: 'verified', detail: 'uji' }])),
    // Tanpa jaringan: pencarian literatur palsu.
    makeLiterature: () => async () => ({ papers: [FAKE_PAPER], errors: [], stats: {} }),
    limits,
    log: { error: (m) => logs.push(m) },
    ...opts
  })
  const call = async (method, route, { body, cookie, token } = {}) => {
    const headers = {}
    if (body) headers['content-type'] = 'application/json'
    if (cookie) headers.cookie = cookie
    if (token) headers.authorization = `Bearer ${token}`
    const res = await app.handle(new Request(`https://council.test/api/${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined }))
    const type = res.headers.get('content-type') || ''
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() }
  }
  const settle = async () => {
    while (tasks.length) await Promise.all(tasks.splice(0))
  }
  return { kv, app, call, settle, tasks, logs }
}

async function login(call) {
  const r = await call('POST', 'login', { body: { password: 'rahasia' } })
  assert.equal(r.status, 200)
  return r.headers.get('set-cookie').split(';')[0]
}

test('routeOf: path langsung (lokal), ?path= (UI), dan URL fungsi Vercel /api/index', () => {
  assert.deepEqual(routeOf(new Request('https://x.test/api/runs/a%20b/events/3')), ['runs', 'a b', 'events', '3'])
  assert.deepEqual(routeOf(new Request('https://x.test/api?path=runs/abc/events/3')), ['runs', 'abc', 'events', '3'])
  assert.deepEqual(routeOf(new Request(`https://x.test/api?path=${encodeURIComponent('runs/a b/events/3')}`)), ['runs', 'a b', 'events', '3'])
  assert.deepEqual(routeOf(new Request('https://x.test/api/index?path=login')), ['login'])
  assert.deepEqual(routeOf(new Request('https://x.test/api/index.js?path=login')), ['login'])
  assert.deepEqual(routeOf(new Request('https://x.test/api/index')), [])
  assert.deepEqual(routeOf(new Request('https://x.test/api')), [])
})

test('rute tak dikenal dijawab 404 (bukan "belum login"), lengkap dengan URL yang diterima fungsi', async () => {
  const { app } = setup()
  const send = async (url, method = 'GET') => {
    const res = await app.handle(new Request(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }))
    return { status: res.status, data: await res.json() }
  }
  const lost = await send('https://x.test/api/index', 'POST')
  assert.equal(lost.status, 404)
  assert.match(lost.data.error, /rute tidak dikenal: POST \/api\/ \(diterima: \/api\/index\)/)
  assert.match((await send('https://x.test/api?path=apa')).data.error, /diterima: \/api\?path=apa/)
  // Rute yang dikenal tetap butuh login.
  for (const [method, path] of [['GET', 'config'], ['GET', 'models'], ['GET', 'doctor/quick'], ['GET', 'runs'], ['POST', 'runs'], ['GET', 'runs/x/events/0'], ['POST', 'runs/x/cancel'], ['GET', 'runs/x/report'], ['GET', 'memories']]) {
    const r = await send(`https://x.test/api?path=${encodeURIComponent(path)}`, method)
    assert.equal(r.status, 401, `${method} ${path}`)
  }
  assert.deepEqual((await send('https://x.test/api?path=health')).data, { ok: true, kv: 'memory', auth: true, route: 'health' })
})

test('config cloud: hanya agen API, model wajib dipilih, COUNCIL_CONFIG bisa menggantikan', () => {
  const base = cloudConfig({})
  assert.deepEqual(base.panel, CLOUD_CONFIG.panel)
  assert.equal(base.moderator.model, '')
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/deepseek-only.json'), 'utf8'))
  assert.deepEqual(file, CLOUD_CONFIG, 'examples/deepseek-only.json harus sama dengan CLOUD_CONFIG')
  assert.deepEqual(runConfigErrors(base), [
    'model untuk DeepSeek Pro belum dipilih',
    'model untuk DeepSeek Flash belum dipilih',
    'model untuk DeepSeek Flash (B) belum dipilih',
    'model untuk moderator (DeepSeek Pro) belum dipilih'
  ])
  const cli = mergeConfig(DEFAULT_CONFIG, {})
  assert.match(runConfigErrors(cli).join('\n'), /agen "claude" \(claude-cli\) memakai login langganan/)
  assert.ok(!runConfigErrors(cli, { allowCli: true }).some((e) => e.includes('langganan')))
  assert.deepEqual(cloudConfig({ COUNCIL_CONFIG: JSON.stringify({ panel: ['deepseek'] }) }).panel, ['deepseek'])
  assert.throws(() => cloudConfig({ COUNCIL_CONFIG: '{' }), /COUNCIL_CONFIG bukan JSON/)
})

test('login: password, cookie, token bot, batas percobaan, keluar', async () => {
  const { call } = setup()
  assert.equal((await call('GET', 'health')).data.ok, true)
  assert.equal((await call('GET', 'config')).status, 401)
  assert.deepEqual((await call('GET', 'me')).data, { loggedIn: false, authRequired: true })
  const wrong = await call('POST', 'login', { body: { password: 'salah' } })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.data.error, 'password salah')

  const cookie = await login(call)
  assert.match(cookie, /^council_session=v1\.\d+\./)
  assert.equal((await call('GET', 'config', { cookie })).status, 200)
  assert.equal((await call('GET', 'config', { cookie: cookie.replace(/.$/, 'x') })).status, 401)
  assert.equal((await call('GET', 'config', { token: 'tok-bot' })).status, 200)
  assert.equal((await call('GET', 'config', { token: 'tok-salah' })).status, 401)
  assert.match((await call('POST', 'logout')).headers.get('set-cookie'), /Max-Age=0/)

  for (let i = 0; i < 9; i++) await call('POST', 'login', { body: { password: 'x' } })
  const blocked = await call('POST', 'login', { body: { password: 'rahasia' } })
  assert.equal(blocked.status, 429)

  const open = setup({ env: {} })
  assert.equal((await open.call('POST', 'login', { body: { password: 'x' } })).status, 503)
  assert.equal((await open.call('GET', 'config')).status, 401)
})

test('sidang lewat API: validasi, berjalan sampai selesai, laporan, memori, dan batas', async () => {
  const { call, settle, kv } = setup({ limits: { dailyRuns: 2 } })
  const cookie = await login(call)
  const post = (body) => call('POST', 'runs', { cookie, body })

  assert.equal((await post({ topic: '  ' })).status, 400)
  assert.match((await post({ topic: 'x', maxRounds: 0 })).data.error, /ronde harus 1–10/)
  assert.match((await post({ topic: 'x', models: { p: '' } })).data.error, /model untuk DS Pro belum dipilih/)
  assert.match((await post({ topic: 'x', models: { zzz: 'm' } })).data.error, /agen "zzz" tidak ada/)
  assert.match((await post({ topic: 'x', memory: ['tidak-ada'] })).data.error, /memori sidang "tidak-ada" tidak ada/)

  const created = await post({ topic: 'Ide hackathon', consensus: 'majority', web: false, models: { q: 'm-flash' }, moderatorModel: 'm-pro' })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const id = created.data.run.id
  assert.equal((await post({ topic: 'kedua' })).status, 409)
  await settle()

  const all = await call('GET', `runs/${id}/events/0`, { cookie })
  assert.equal(all.data.run.status, 'finished')
  assert.equal(all.data.run.moderator.model, 'm-pro')
  assert.equal(all.data.events.at(-1).type, 'finished')
  assert.equal(all.data.next, all.data.events.length)
  const tail = await call('GET', `runs/${id}/events/${all.data.next - 1}`, { cookie })
  assert.deepEqual(tail.data.events.map((e) => e.type), ['finished'])
  const meta = await readMeta(kv, id)
  assert.equal(meta.config.consensus, 'majority')
  assert.equal(meta.config.web, false)
  // Tahap riset aktif bawaan: literatur (palsu) lalu hasil riset, sebelum ronde 1.
  const types = all.data.events.map((e) => e.type)
  assert.ok(types.indexOf('literature') > types.indexOf('framed') && types.indexOf('researched') < types.indexOf('round_started'))
  assert.equal(meta.config.research.enabled, true)

  const report = await call('GET', `runs/${id}/report`, { cookie })
  assert.equal(report.status, 200)
  assert.match(report.headers.get('content-type'), /text\/markdown/)
  assert.match(report.data, /^# The Council — Q\?/)
  assert.equal((await call('GET', 'runs/tidak-ada/report', { cookie })).status, 404)
  assert.equal((await call('GET', 'runs/tidak-ada/events/0', { cookie })).status, 404)

  const memories = await call('GET', 'memories', { cookie })
  assert.deepEqual(memories.data.runs.map((r) => r.id), [id])
  const next = await post({ topic: 'Lanjutan', memory: [id], research: false })
  assert.equal(next.status, 201)
  assert.equal((await readMeta(kv, next.data.run.id)).config.research.enabled, false)
  assert.equal(CONFIG.research.enabled, true, 'config server tidak ikut berubah')
  assert.deepEqual(next.data.run.memory.map((m) => m.id), [id])
  await settle()
  assert.equal((await post({ topic: 'ketiga' })).status, 429)
  assert.deepEqual((await call('GET', 'runs', { cookie })).data.runs.map((r) => r.topic), ['Lanjutan', 'Ide hackathon'])
})

test('membuka sidang yang dijeda melanjutkannya; batal menghentikannya', async () => {
  const slowFrame = { FRAME: async () => (await sleep(80), { question: 'Q?', criteria: [], context: '' }) }
  const { call, settle, kv, tasks } = setup({ script: slowFrame })
  const cookie = await login(call)
  const { data } = await call('POST', 'runs', { cookie, body: { topic: 'Batal' } })
  const id = data.run.id
  const cancel = await call('POST', `runs/${id}/cancel`, { cookie })
  assert.equal(cancel.status, 202)
  await settle()
  const meta = await readMeta(kv, id)
  assert.equal(meta.status, 'cancelled')
  const events = (await call('GET', `runs/${id}/events/0`, { cookie })).data
  assert.equal(events.events.at(-1).type, 'cancelled')
  assert.equal(events.run.active, false)
  assert.equal(tasks.length, 0) // sidang yang sudah berhenti tidak dijalankan lagi

  // Sidang berstatus "running" tanpa slice aktif (mis. fungsi sebelumnya habis waktu) dilanjutkan saat dibuka.
  const again = await call('POST', 'runs', { cookie, body: { topic: 'Jeda' } })
  await settle()
  const paused = await readMeta(kv, again.data.run.id)
  await kv.set(`run:${paused.id}:meta`, JSON.stringify({ ...paused, status: 'running' }))
  await kv.del(`run:${paused.id}:events`)
  const opened = await call('GET', `runs/${paused.id}/events/0`, { cookie })
  assert.equal(opened.data.run.active, true)
  assert.equal(tasks.length, 1)
  await settle()
  assert.equal((await readMeta(kv, paused.id)).status, 'finished')
})

test('model, doctor, dan rute tidak dikenal', async () => {
  const doctorCalls = []
  const { call } = setup({ doctor: async (config, opts) => (doctorCalls.push(opts.quick), { ok: true, results: [] }) })
  const cookie = await login(call)
  assert.deepEqual((await call('GET', 'models', { cookie })).data.models, ['m-pro', 'm-flash'])
  const cfg = (await call('GET', 'config', { cookie })).data
  assert.deepEqual(cfg.panel.map((a) => [a.id, a.label, a.model]), [['p', 'DS Pro', 'm-pro'], ['q', 'DS Flash', 'm-flash']])
  assert.equal(cfg.moderator.id, 'p')
  assert.equal(cfg.defaults.research, true)
  await call('GET', 'doctor/quick', { cookie })
  await call('GET', 'doctor', { cookie })
  assert.deepEqual(doctorCalls, [true, false])
  const unknown = await call('GET', 'apa', { cookie })
  assert.equal(unknown.status, 404)
  assert.match(unknown.data.error, /rute tidak dikenal: GET \/api\/apa/)
})

test('server lokal: file statis, API, dan path traversal ditolak', async (t) => {
  const { app } = setup({ env: {}, requireAuth: false })
  const server = await startServer({ app, port: 0 })
  t.after(server.close)
  const page = await fetch(`${server.url}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>The Council<\/title>/)
  assert.match((await fetch(`${server.url}/app.js`)).headers.get('content-type'), /javascript/)
  assert.deepEqual(await (await fetch(`${server.url}/api/me`)).json(), { loggedIn: true, authRequired: false })
  const created = await fetch(`${server.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'lokal' }) })
  assert.equal(created.status, 201)
  assert.equal((await fetch(`${server.url}/..%2Fpackage.json`)).status, 404)
  assert.equal((await fetch(`${server.url}/tidak-ada.js`)).status, 404)
})

test('council ui menyalakan server lokal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-ui-'))
  const child = spawn(process.execPath, [path.join(ROOT, 'src/index.js'), 'ui', '--port', '0'], { cwd: dir, env: { ...process.env, COUNCIL_PASSWORD: '' } })
  t.after(() => child.kill())
  const url = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
      const m = out.match(/UI: (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) resolve(m[1])
    })
    child.on('exit', (code) => reject(new Error(`keluar dengan kode ${code}`)))
  })
  const health = await (await fetch(`${url}/api/health`)).json()
  assert.deepEqual(health, { ok: true, kv: 'memory', auth: 'lokal', route: 'health' })
  const cfg = await (await fetch(`${url}/api/config`)).json()
  assert.deepEqual(cfg.panel.map((a) => a.id), ['claude', 'codex', 'deepseek'])
})

test('batas waktu agen: dipotong ke callTimeoutMs di server, apa adanya tanpa batas', async () => {
  const seen = []
  const makeAgents = (config) => {
    seen.push(Object.fromEntries(Object.entries(config.agents).filter(([id]) => ['p', 'q'].includes(id)).map(([id, a]) => [id, a.timeoutMs])))
    return {}
  }
  const config = mergeConfig(CONFIG, { agents: { p: { timeoutMs: 600000 }, q: { timeoutMs: undefined } } })
  for (const limits of [{ callTimeoutMs: 180000 }, { maxDurationMs: Infinity, callTimeoutMs: Infinity }]) {
    const app = createApp({ kv: memoryKv(), config, env: {}, requireAuth: false, limits, makeAgents })
    await app.handle(new Request('https://x.test/api/models'))
  }
  assert.deepEqual(seen, [{ p: 180000, q: 180000 }, { p: 600000, q: undefined }])
})

test('slot satu sidang diklaim atomik: dua POST bersamaan, hanya satu yang jalan; slot basi bisa dipakai lagi', async () => {
  const { call, settle, kv } = setup()
  const cookie = await login(call)
  const post = (topic) => call('POST', 'runs', { cookie, body: { topic } })
  const [a, b] = await Promise.all([post('pertama'), post('kedua')])
  assert.deepEqual([a.status, b.status].sort(), [201, 409])
  const winner = (a.status === 201 ? a : b).data.run.id
  assert.equal(parseActive(await kv.get('active')).id, winner)
  assert.equal((await call('GET', 'runs', { cookie })).data.runs.length, 1)
  await settle()

  // Pemegang slot yang sudah berhenti (mis. sidang selesai tapi slot tidak sempat dilepas) tidak menghalangi.
  await kv.set('active', `${winner}|${Date.now()}`)
  const next = await post('ketiga')
  assert.equal(next.status, 201, JSON.stringify(next.data))
  assert.equal(parseActive(await kv.get('active')).id, next.data.run.id)
  // Pemegang yang meta-nya belum ada: dianggap sedang dibuat kalau baru diklaim, basi kalau sudah lama.
  await settle()
  await kv.set('active', `sedang-dibuat|${Date.now()}`)
  assert.equal((await post('keempat')).status, 409)
  await kv.set('active', `macet|${Date.now() - 10 * 60000}`)
  assert.equal((await post('kelima')).status, 201)
  await settle()
  assert.equal(await kv.get('active'), null)

  // Kuota habis: slot dilepas lagi, jadi tidak tertahan.
  const limited = setup({ limits: { dailyRuns: 0 } })
  const c2 = await login(limited.call)
  assert.equal((await limited.call('POST', 'runs', { cookie: c2, body: { topic: 'x' } })).status, 429)
  assert.equal(await limited.kv.get('active'), null)
})

test('sidang gagal tampil sebagai error dan tidak bisa dilanjutkan', async () => {
  const { call, settle } = setup({ script: { PANEL: new Error('HTTP 500 dari penyedia') } })
  const cookie = await login(call)
  const { data } = await call('POST', 'runs', { cookie, body: { topic: 'Gagal' } })
  await settle()
  const run = (await call('GET', `runs/${data.run.id}/events/0`, { cookie })).data.run
  assert.equal(run.status, 'error')
  assert.match(run.error, /tanpa kesimpulan/)
  assert.deepEqual((await call('GET', 'memories', { cookie })).data.runs, [])
  const cont = await call('POST', 'runs', { cookie, body: { topic: 'Lanjut', memory: [data.run.id] } })
  assert.equal(cont.status, 400)
  assert.match(cont.data.error, /tidak ada/)
})
