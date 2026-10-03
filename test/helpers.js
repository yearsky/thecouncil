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
  RESEARCH: {
    insights: [
      { finding: 'temuan dari paper', sources: ['S1'], why_non_obvious: 'jarang dibahas', implication: 'peluang', open_question: '' },
      { finding: 'temuan dari web', sources: ['C1'] }
    ],
    gaps: ['celah'],
    why_now: ['regulasi baru'],
    claims: [
      { id: 'C1', text: 'klaim riset web', kind: 'fact', source_url: 'https://riset.test/a', quote: 'q' },
      { id: 'C2', text: 'klaim dari abstrak', kind: 'fact', source_url: 'S1', quote: 'satellite vegetation indices predict repayment' }
    ]
  },
  JUDGE: ({ round }) => ({ summary: `ringkas r${round}`, agreements: ['a'], disagreements: [], draft: `draft r${round}`, next_focus: `fokus r${round}` }),
  VOTE: { vote: { on_draft: 'AGREE' } }
}

// `searches`: jumlah pencarian yang dilaporkan agen saat diberi web search (meta seperti agen API).
export function scriptedAgent(id, script = {}, { webSearch = false, searches = null } = {}) {
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
      const meta = searches !== null && req.webSearch ? { webSearchRequests: searches, searchUrls: Array.from({ length: searches }, (_, i) => `https://${id}.cari/${i + 1}`) } : undefined
      return { text: typeof value === 'string' ? value : JSON.stringify(value), costUsd: 0.01, tokens: { input: 100, cacheRead: 20, cacheWrite: 0, output: 10 }, ...(meta ? { meta } : {}) }
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

// Paper palsu untuk uji tahap riset. Abstraknya memuat kutipan yang dipakai jawaban RESEARCH di atas.
export const FAKE_PAPER = {
  id: 'S1',
  source: 'semanticscholar',
  title: 'Credit scoring for smallholder farmers using satellite data',
  year: 2024,
  venue: 'World Development',
  authors: ['Sari Dewi'],
  citations: 40,
  doi: '10.1000/abc.1',
  url: 'https://doi.org/10.1000/abc.1',
  altUrls: ['https://www.semanticscholar.org/paper/a1'],
  abstract: 'Smallholder farmers lack formal credit histories. We show satellite vegetation indices predict repayment.',
  tldr: '',
  foundIn: ['semanticscholar'],
  queries: ['q']
}

// Server yang meniru Semantic Scholar, OpenAlex, dan arXiv (satu paper yang sama di ketiganya).
export async function startFakeScholar() {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url.startsWith('/graph/v1/paper/search')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          data: [{ title: FAKE_PAPER.title, year: 2024, venue: 'World Development', citationCount: 40, externalIds: { DOI: '10.1000/abc.1' }, url: FAKE_PAPER.altUrls[0], abstract: FAKE_PAPER.abstract, authors: [{ name: 'Sari Dewi' }] }]
        })
      )
    }
    if (req.url.startsWith('/works')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ results: [{ id: 'https://openalex.org/W9', doi: null, display_name: 'Cold chain losses in Indonesian fisheries', publication_year: 2025, cited_by_count: 3, abstract_inverted_index: { Post: [0], harvest: [1], losses: [2] } }] }))
    }
    if (req.url.startsWith('/api/query')) {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' })
      return res.end('<feed></feed>')
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, requests, baseURLs: { semanticscholar: url, openalex: url, arxiv: url }, close: () => new Promise((resolve) => server.close(resolve)) }
}
