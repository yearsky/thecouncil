import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeConfig, DEFAULT_CONFIG } from '../src/config.js'
import { checkUrl, extractUrls, formatDoctor, runDoctor } from '../src/doctor.js'
import { createStyle } from '../src/ui/style.js'
import { fakeBin, startFakeApi } from './helpers.js'

const plain = createStyle(false)

async function setup(t, overrides = {}) {
  const api = await startFakeApi()
  t.after(api.close)
  process.env.FAKE_URL = `${api.url}/source`
  process.env.TEST_DS_KEY = 'sk-test'
  t.after(() => {
    delete process.env.FAKE_URL
    delete process.env.TEST_DS_KEY
  })
  const fakes = {
    claude: { bin: fakeBin('fake-claude.js') },
    codex: { bin: fakeBin('fake-codex.js') },
    deepseek: { baseURL: `${api.url}/anthropic`, modelsURL: api.url, apiKeyEnv: 'TEST_DS_KEY', model: 'fake-pro' }
  }
  const agents = {}
  for (const id of Object.keys(fakes)) agents[id] = { ...fakes[id], ...overrides.agents?.[id] }
  return { api, config: mergeConfig(DEFAULT_CONFIG, { ...overrides, agents }) }
}

const byId = (report, id) => report.results.find((r) => r.id === id)
const check = (result, name) => result.checks.find((c) => c.name === name)

test('extractUrls membersihkan tanda baca dan markdown', () => {
  assert.deepEqual(extractUrls('Lihat [ini](https://a.com/x). Juga https://b.org/y, dan https://a.com/x'), ['https://a.com/x', 'https://b.org/y'])
  assert.deepEqual(extractUrls('tanpa tautan'), [])
})

test('checkUrl melaporkan status atau error', async (t) => {
  const api = await startFakeApi()
  t.after(api.close)
  assert.deepEqual(await checkUrl(`${api.url}/source`), { ok: true, status: 200 })
  assert.deepEqual(await checkUrl(`${api.url}/models`), { ok: false, status: 401 }) // tanpa API key
  assert.equal((await checkUrl('http://127.0.0.1:1/x', { timeoutMs: 2000 })).ok, false)
})

test('doctor: semua agen siap', async (t) => {
  const { config } = await setup(t, { moderator: { model: 'opus' } })
  const report = await runDoctor(config)
  assert.equal(report.ok, true)

  const claude = byId(report, 'claude')
  assert.equal(claude.status, 'ok')
  assert.match(check(claude, 'uji dasar').detail, /^sonnet ·/)
  assert.match(check(claude, 'uji moderator').detail, /^opus ·/)
  assert.match(check(claude, 'web search').detail, /\/source → HTTP 200/)

  const codex = byId(report, 'codex')
  assert.equal(check(codex, 'web search').status, 'ok')
  assert.match(check(codex, 'web search').detail, /tidak bisa dipastikan/)

  const deepseek = byId(report, 'deepseek')
  assert.equal(check(deepseek, 'model').detail, 'fake-pro')
  assert.equal(check(deepseek, 'web search').status, 'ok')
  assert.match(check(deepseek, 'web search').detail, /\/source → HTTP 200/)

  const text = formatDoctor(report, { style: plain, source: 'council.config.json' })
  assert.match(text, /✔ Claude \(claude-cli\)/)
  assert.match(text, /Hasil: 3 siap\./)
})

test('doctor --quick tidak memanggil AI', async (t) => {
  const { api, config } = await setup(t)
  const report = await runDoctor(config, { quick: true })
  assert.equal(report.ok, true)
  assert.deepEqual(byId(report, 'claude').checks.map((c) => c.name), ['terpasang'])
  assert.ok(!api.requests.some((q) => q.url === '/chat/completions' || q.url === '/anthropic/v1/messages'))
})

test('doctor: CLI tidak ada, belum login, dan API key kosong dilaporkan gagal', async (t) => {
  const { config } = await setup(t, {
    agents: { claude: { bin: 'claude-yang-tidak-ada-xyz' }, deepseek: { apiKeyEnv: 'KUNCI_KOSONG_XYZ' } }
  })
  process.env.FAKE_CODEX_MODE = 'fail'
  t.after(() => delete process.env.FAKE_CODEX_MODE)
  const report = await runDoctor(config)
  assert.equal(report.ok, false)
  assert.match(check(byId(report, 'claude'), 'terpasang').detail, /claude-yang-tidak-ada-xyz/)
  assert.match(check(byId(report, 'codex'), 'uji dasar').detail, /Not logged in/)
  assert.match(check(byId(report, 'deepseek'), 'API key').detail, /KUNCI_KOSONG_XYZ belum diisi/)
  assert.match(formatDoctor(report, { style: plain }), /Hasil: 0 siap, 3 bermasalah\./)
})

test('doctor: model DeepSeek kosong → pakai model pertama dengan peringatan', async (t) => {
  const { config } = await setup(t, { agents: { deepseek: { model: '' } } })
  const report = await runDoctor(config, { only: 'deepseek' })
  const deepseek = byId(report, 'deepseek')
  assert.equal(deepseek.status, 'warn')
  assert.match(check(deepseek, 'model').detail, /tersedia: fake-flash, fake-pro \(uji pakai fake-flash\)/)
  assert.equal(check(deepseek, 'uji dasar').status, 'ok')
})

test('doctor: plugin ikut termuat (info) dan WebSearch tidak dipanggil (peringatan)', async (t) => {
  const { config } = await setup(t)
  process.env.FAKE_CLAUDE_MODE = 'plugins'
  t.after(() => delete process.env.FAKE_CLAUDE_MODE)
  let claude = byId(await runDoctor(config, { only: 'claude' }), 'claude')
  assert.equal(claude.status, 'ok')
  assert.equal(check(claude, 'catatan').status, 'info')
  assert.match(check(claude, 'catatan').detail, /plugin: superpowers.*--restricted bisa dicoba/)
  assert.match(formatDoctor({ ok: true, results: [claude] }, { style: plain }), /• catatan/)

  config.agents.claude.extraArgs = ['--restricted']
  claude = byId(await runDoctor(config, { only: 'claude' }), 'claude')
  assert.match(check(claude, 'catatan').detail, /--restricted sudah dipakai, tapi tetap termuat/)

  process.env.FAKE_CLAUDE_MODE = 'no-search'
  claude = byId(await runDoctor(config, { only: 'claude' }), 'claude')
  assert.equal(check(claude, 'web search').status, 'warn')
  assert.match(check(claude, 'web search').detail, /URL mungkin dari ingatan/)
})

test('doctor: moderator yang bukan panelis diuji dengan model moderator', async (t) => {
  const { config } = await setup(t, { panel: ['codex'], moderator: { agent: 'claude', model: 'opus' } })
  const report = await runDoctor(config, { web: false })
  const claude = byId(report, 'claude')
  assert.match(check(claude, 'uji dasar').detail, /^opus ·/)
  assert.equal(check(claude, 'uji moderator'), undefined)
  assert.equal(check(claude, 'web search').status, 'skip')
})
