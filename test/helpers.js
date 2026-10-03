// Membuat "binary" palsu dari script fixture. Di Windows dibungkus file .cmd,
// sehingga test ikut melewati jalur cmd.exe + quoting yang dipakai CLI sungguhan.
// Disalin dari yearsky/chatbot-wa (test/helpers.js).
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fenced, stageAnswer, stageOf } from './fixtures/stage-answers.js'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function fakeBin(fixture) {
  const script = path.join(FIXTURES, fixture)
  if (process.platform !== 'win32') return script
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-fakebin-'))
  const cmd = path.join(dir, fixture.replace(/\.js$/, '.cmd'))
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  return cmd
}

// Agen palsu di dalam proses untuk menguji protokol sidang. Tahap dikenali dari baris "Tahap: ..." di prompt;
// tiap tahap bisa diganti lewat `script` (objek, string mentah, Error, atau fungsi ({ round, req, n }) => ...).
const DEFAULT_SCRIPT = {
  FRAME: { question: 'Q?', criteria: ['k1'], context: '' },
  PANEL: ({ id, round }) => ({
    position: `posisi ${id} r${round}`,
    proposals: [{ title: `ide ${id}` }],
    claims: [{ text: `klaim ${id}`, kind: 'fact', source_url: `https://${id}.test/a`, quote: 'q' }],
    ...(round > 1 ? { vote: { on_draft: 'AGREE' } } : {})
  }),
  JUDGE: ({ round }) => ({ summary: `ringkas r${round}`, agreements: ['a'], disagreements: [], draft: `draft r${round}`, next_focus: `fokus r${round}` }),
  VOTE: { vote: { on_draft: 'AGREE' } }
}

export function scriptedAgent(id, script = {}, { webSearch = false } = {}) {
  const calls = []
  return {
    id,
    label: id.toUpperCase(),
    model: `${id}-model`,
    capabilities: { webSearch },
    calls,
    async ask(req) {
      calls.push(req)
      const stage = req.prompt.startsWith('Jawabanmu sebelumnya') ? 'REPAIR' : req.prompt.match(/^Tahap: (\w+)/m)?.[1]
      const round = Number(req.prompt.match(/Tahap: \w+ · Ronde (\d+)/)?.[1] || 0)
      const handler = Object.hasOwn(script, stage) ? script[stage] : DEFAULT_SCRIPT[stage]
      const value = typeof handler === 'function' ? await handler({ id, round, req, n: calls.length }) : handler
      if (value instanceof Error) throw value
      if (value === undefined) throw new Error(`tahap ${stage} tidak ditangani`)
      return { text: typeof value === 'string' ? value : JSON.stringify(value), costUsd: 0.01, tokens: { input: 100, cacheRead: 20, cacheWrite: 0, output: 10 } }
    }
  }
}

// Jawaban format Anthropic Messages. Dengan tool web search: blok server_tool_use + web_search_tool_result.
// Prompt yang memuat "PAUSE" dijawab "pause_turn" dulu; sidang ("Tahap: ...") dijawab JSON per tahap.
function anthropicReply({ model, messages, tools }, { url, disagree }) {
  const first = messages[0].content
  const prompt = typeof first === 'string' ? first : ''
  const searching = Array.isArray(tools) && tools.some((t) => t.type === 'web_search_20250305')
  const usage = { input_tokens: 50, cache_read_input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: searching ? 1 : 0 } }
  const continued = messages.length > 1
  if (prompt.includes('PAUSE') && !continued) {
    return { model, stop_reason: 'pause_turn', usage, content: [{ type: 'server_tool_use', id: 's0', name: 'web_search', input: { query: 'x' } }] }
  }
  const content = []
  if (searching) {
    content.push({ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'node lts' } })
    content.push({ type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: `${url}/source`, title: 'Sumber' }] })
  }
  const stage = stageOf(prompt)
  if (stage) content.push({ type: 'text', text: fenced(stageAnswer(stage, prompt, { model, disagree, source: `${url}/source` })) })
  else if (prompt.includes('SIAP')) content.push({ type: 'text', text: 'SIAP' })
  else if (searching) content.push({ type: 'text', text: 'Node.js 24 adalah LTS terbaru. Sumber: ' }, { type: 'text', text: `${url}/source` })
  else content.push({ type: 'text', text: `jawaban untuk: ${prompt}` })
  return { model, stop_reason: prompt.includes('PANJANG') ? 'max_tokens' : 'end_turn', usage, content }
}

// Server lokal yang meniru API DeepSeek (format OpenAI di /, format Anthropic di /anthropic) dan halaman
// sumber untuk uji URL. `rejectSearch`: endpoint Anthropic menolak tool web search (HTTP 400).
export async function startFakeApi({ models = ['fake-flash', 'fake-pro'], apiKey = 'sk-test', rejectSearch = false, disagree = false, delayMs = 0 } = {}) {
  const requests = []
  let url
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, apiKey: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: body ? JSON.parse(body) : null })
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (req.url === '/source') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end('<p>Node.js 24 adalah versi LTS.</p>')
      }
      if (req.url === '/anthropic/v1/messages') {
        if (delayMs) return setTimeout(() => answerAnthropic(), delayMs)
        return answerAnthropic()
      }
      function answerAnthropic() {
        if (req.headers['x-api-key'] !== apiKey) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
        const data = JSON.parse(body)
        if (!models.includes(data.model)) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: `Model Not Exist: ${data.model}` } })
        if (rejectSearch && data.tools?.length) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'unknown tool type' } })
        return send(200, anthropicReply(data, { url, disagree }))
      }
      if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: { message: 'Authentication Fails' } })
      if (req.url === '/models') return send(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) })
      if (req.url === '/chat/completions') {
        const { model, messages } = JSON.parse(body)
        if (!models.includes(model)) return send(400, { error: { message: `Model Not Exist: ${model}` } })
        const prompt = messages.at(-1).content
        const content = prompt.includes('SIAP') ? 'SIAP' : `jawaban untuk: ${prompt}`
        return send(200, { model, choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 7 } })
      }
      send(404, { error: { message: 'not found' } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}
