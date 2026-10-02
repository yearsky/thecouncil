import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeArgs, createClaudeAgent, parseClaudeStream, safeArg } from '../src/agents/claude.js'
import { codexArgs, createCodexAgent } from '../src/agents/codex.js'
import { createOpenAiCompatAgent } from '../src/agents/openaiCompat.js'
import { createAgent } from '../src/agents/index.js'
import { fakeBin, startFakeApi } from './helpers.js'

test('safeArg membuang karakter yang berbahaya untuk cmd.exe', () => {
  assert.equal(safeArg('a "b"\r\nc % ^ & < > | d'), "a 'b' c       d")
})

test('claudeArgs: tanpa --bare, --tools paling akhir, web search hanya jika diminta', () => {
  const plain = claudeArgs({ system: 'Peran "moderator"', model: 'sonnet' })
  assert.ok(!plain.includes('--bare'))
  assert.deepEqual(plain.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose'])
  assert.equal(plain[plain.indexOf('--system-prompt') + 1], "Peran 'moderator'")
  assert.deepEqual(plain.slice(-2), ['--tools', ''])
  assert.ok(!plain.includes('--allowedTools'))

  const web = claudeArgs({ webSearch: true, extraArgs: ['--restricted'] })
  assert.deepEqual(web.slice(-4), ['--allowedTools', 'WebSearch,WebFetch', '--tools', 'WebSearch,WebFetch'])
  assert.ok(web.indexOf('--restricted') < web.indexOf('--allowedTools'))
})

test('parseClaudeStream membaca init, pemakaian tool, dan hasil', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'm1', tools: ['WebSearch'], plugins: [{ name: 'p' }], mcp_servers: [] }),
    'baris bukan json',
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'WebSearch' }] } }),
    JSON.stringify({ type: 'assistant', parent_tool_use_id: 'sub', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'halo', total_cost_usd: 0.01 })
  ].join('\n')
  const r = parseClaudeStream(stdout)
  assert.equal(r.text, 'halo')
  assert.equal(r.costUsd, 0.01)
  assert.deepEqual(r.meta, { model: 'm1', tools: ['WebSearch'], plugins: ['p'], mcpServers: [], toolUses: { WebSearch: 1 } })

  assert.throws(() => parseClaudeStream('{"type":"result","is_error":true,"result":"limit"}'), /Claude error: limit/)
  assert.throws(() => parseClaudeStream(''), /event "result" tidak ada/)
})

test('agen Claude: prompt lewat stdin, error login dibuat jelas', async () => {
  const agent = createClaudeAgent({ bin: fakeBin('fake-claude.js'), model: 'sonnet' })
  assert.equal(await agent.version(), '9.9.9 (Claude Code)')
  const r = await agent.ask({ system: 'uji', prompt: 'Balas: SIAP' })
  assert.equal(r.text, 'SIAP')
  assert.equal(r.meta.model, 'sonnet')

  process.env.FAKE_CLAUDE_MODE = 'not-logged-in'
  try {
    await assert.rejects(agent.ask({ prompt: 'x' }), /Claude error: Not logged in/)
  } finally {
    delete process.env.FAKE_CLAUDE_MODE
  }
})

test('codexArgs: sandbox read-only, opsi web sebelum "-" (stdin)', () => {
  const args = codexArgs({ outFile: 'o.txt', model: 'gpt-x', webSearch: true, webSearchArgs: ['--search'] })
  assert.deepEqual(args.slice(0, 2), ['exec', '--skip-git-repo-check'])
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.deepEqual(args.slice(-2), ['--search', '-'])
  assert.ok(!codexArgs({ outFile: 'o.txt' }).includes('web_search=live'))
})

test('agen Codex: system digabung ke prompt, jawaban dari --output-last-message', async () => {
  const agent = createCodexAgent({ bin: fakeBin('fake-codex.js') })
  assert.equal(await agent.version(), 'codex-cli 9.9.9')
  assert.equal((await agent.ask({ system: 'peran', prompt: 'Balas: SIAP' })).text, 'SIAP')
  assert.match((await agent.ask({ prompt: 'cari', webSearch: true })).text, /LTS terbaru/)

  process.env.FAKE_CODEX_MODE = 'fail'
  try {
    await assert.rejects(agent.ask({ prompt: 'x' }), /Not logged in/)
  } finally {
    delete process.env.FAKE_CODEX_MODE
  }
})

test('agen OpenAI-compatible (DeepSeek): daftar model, chat, dan pesan error', async (t) => {
  const api = await startFakeApi()
  t.after(api.close)
  process.env.TEST_DS_KEY = 'sk-test'
  t.after(() => delete process.env.TEST_DS_KEY)

  const agent = createOpenAiCompatAgent({ baseURL: `${api.url}/`, model: 'fake-flash', apiKeyEnv: 'TEST_DS_KEY' })
  assert.deepEqual(await agent.listModels(), ['fake-flash', 'fake-pro'])
  const r = await agent.ask({ system: 'peran', prompt: 'Balas: SIAP' })
  assert.equal(r.text, 'SIAP')
  const chat = api.requests.find((q) => q.url === '/chat/completions')
  assert.deepEqual(chat.body.messages.map((m) => m.role), ['system', 'user'])

  await assert.rejects(agent.ask({ prompt: 'x', model: 'tidak-ada' }), /HTTP 400: Model Not Exist/)
  await assert.rejects(createOpenAiCompatAgent({ baseURL: api.url, apiKeyEnv: 'TEST_DS_KEY' }).ask({ prompt: 'x' }), /Model DeepSeek belum diisi/)
  await assert.rejects(createOpenAiCompatAgent({ baseURL: api.url, apiKeyEnv: 'TIDAK_ADA_KEY' }).listModels(), /TIDAK_ADA_KEY belum diisi/)
})

test('createAgent menolak tipe yang tidak dikenal', () => {
  assert.throws(() => createAgent('x', { type: 'gemini' }), /Tipe agen "gemini" tidak dikenal/)
})
