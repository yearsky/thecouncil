// Uji ujung ke ujung jalur Vercel: api/index.js → Upstash (REST palsu) → runner → agen DeepSeek format Anthropic
// (server palsu, dengan web search) → verifier yang membuka halaman sumber palsu.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { memoryKv } from '../src/store/kv.js'
import { startFakeApi } from './helpers.js'

async function startFakeUpstash(token) {
  const kv = memoryKv()
  const commands = []
  const run = async ([name, ...a]) => {
    switch (name) {
      case 'GET':
        return kv.get(a[0])
      case 'SET': {
        const ex = a.indexOf('EX')
        return (await kv.set(a[0], a[1], { nx: a.includes('NX'), ex: ex > 0 ? Number(a[ex + 1]) : undefined })) ? 'OK' : null
      }
      case 'DEL':
        return kv.del(a[0])
      case 'EXISTS':
        return (await kv.exists(a[0])) ? 1 : 0
      case 'EXPIRE':
        await kv.expire(a[0], Number(a[1]))
        return 1
      case 'INCR':
        return kv.incr(a[0])
      case 'RPUSH':
        return kv.rpush(a[0], ...a.slice(1))
      case 'LPUSH':
        return kv.lpush(a[0], ...a.slice(1))
      case 'LRANGE':
        return kv.lrange(a[0], Number(a[1]), Number(a[2]))
      case 'LLEN':
        return kv.llen(a[0])
      case 'HGET':
        return kv.hget(a[0], a[1])
      case 'HSET':
        await kv.hset(a[0], a[1], a[2])
        return 1
      default:
        throw new Error(`ERR unknown command '${name}'`)
    }
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }
      const args = JSON.parse(body)
      commands.push(args[0])
      try {
        res.end(JSON.stringify({ result: await run(args) }))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: err.message }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, commands, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('fungsi Vercel: login, sidang DeepSeek dengan web search sampai selesai, laporan', async (t) => {
  const deepseek = await startFakeApi()
  const redis = await startFakeUpstash('redis-token')
  t.after(deepseek.close)
  t.after(redis.close)
  const agent = (label) => ({ type: 'anthropic-compatible', label, baseURL: `${deepseek.url}/anthropic`, modelsURL: deepseek.url, model: '', apiKeyEnv: 'DEEPSEEK_API_KEY' })
  Object.assign(process.env, {
    KV_REST_API_URL: redis.url,
    KV_REST_API_TOKEN: 'redis-token',
    DEEPSEEK_API_KEY: 'sk-test',
    COUNCIL_PASSWORD: 'rahasia',
    COUNCIL_CONFIG: JSON.stringify({
      moderator: { agent: 'pro', model: '' },
      panel: ['pro', 'flash'],
      maxRounds: 2,
      agents: { pro: agent('DeepSeek Pro'), flash: agent('DeepSeek Flash') }
    })
  })
  const { GET, POST } = await import('../api/index.js')
  let cookie = ''
  const call = async (method, path, body) => {
    const fn = method === 'GET' ? GET : POST
    const res = await fn(
      new Request(`https://council.test/api?path=${path}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
    )
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const type = res.headers.get('content-type') || ''
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() }
  }

  assert.deepEqual((await call('GET', 'health')).data, { ok: true, kv: 'upstash', auth: true })
  assert.equal((await call('POST', 'login', { password: 'rahasia' })).status, 200)
  assert.deepEqual((await call('GET', 'models')).data.models, ['fake-flash', 'fake-pro'])
  const missing = await call('POST', 'runs', { topic: 'x' })
  assert.match(missing.data.error, /model untuk DeepSeek Pro belum dipilih/)

  const created = await call('POST', 'runs', { topic: 'Ide hackathon UMKM', models: { pro: 'fake-pro', flash: 'fake-flash' } })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const id = created.data.run.id

  // Seperti browser: buka event berkala sampai sidang selesai.
  const events = []
  let next = 0
  let run
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', `runs/${encodeURIComponent(id)}/events/${next}`)
    events.push(...r.data.events)
    next = r.data.next
    run = r.data.run
    if (run.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(run.status, 'finished', JSON.stringify(run))
  const finished = events.at(-1)
  assert.equal(finished.type, 'finished')
  assert.equal(finished.status, 'unanimous')
  assert.equal(finished.verification.verified, 1)
  assert.equal(new Set(events.map((e) => e.id)).size, events.length)

  // Panelis memakai tool web search DeepSeek; moderator tidak.
  const messages = deepseek.requests.filter((q) => q.url === '/anthropic/v1/messages')
  const panelCalls = messages.filter((q) => /Tahap: PANEL/.test(q.body.messages[0].content))
  assert.ok(panelCalls.length >= 2)
  assert.ok(panelCalls.every((q) => q.body.tools?.[0]?.type === 'web_search_20250305' && q.body.tools[0].max_uses === 3))
  assert.ok(messages.filter((q) => /Tahap: (FRAME|JUDGE)/.test(q.body.messages[0].content)).every((q) => !q.body.tools))
  assert.deepEqual([...new Set(messages.map((q) => q.body.model))].sort(), ['fake-flash', 'fake-pro'])

  const report = await call('GET', `runs/${encodeURIComponent(id)}/report`)
  assert.equal(report.status, 200)
  assert.match(report.data, /\| Status \| ✔ BULAT \|/)
  assert.ok(redis.commands.includes('HSET'), 'jurnal ditulis ke Redis')
})
