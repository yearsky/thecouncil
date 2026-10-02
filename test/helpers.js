// Membuat "binary" palsu dari script fixture. Di Windows dibungkus file .cmd,
// sehingga test ikut melewati jalur cmd.exe + quoting yang dipakai CLI sungguhan.
// Disalin dari yearsky/chatbot-wa (test/helpers.js).
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function fakeBin(fixture) {
  const script = path.join(FIXTURES, fixture)
  if (process.platform !== 'win32') return script
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-fakebin-'))
  const cmd = path.join(dir, fixture.replace(/\.js$/, '.cmd'))
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  return cmd
}

// Server lokal yang meniru API DeepSeek (format OpenAI) dan halaman sumber untuk uji URL.
export async function startFakeApi({ models = ['fake-flash', 'fake-pro'], apiKey = 'sk-test' } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (req.url === '/source') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end('<p>Node.js 24 adalah versi LTS.</p>')
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
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}
