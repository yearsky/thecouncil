// `council ui`: server HTTP kecil di PC sendiri (127.0.0.1) untuk UI The Council. Memakai handler yang sama
// dengan fungsi Vercel (src/cloud/app.js), plus file statis di public/. Tanpa dependensi.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

async function toRequest(req, origin) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  const hasBody = !['GET', 'HEAD'].includes(req.method) && chunks.length
  return new Request(new URL(req.url, origin), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined })
}

async function sendResponse(res, response) {
  const headers = {}
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}

function serveStatic(res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(publicDir, rel)
  if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('tidak ditemukan')
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  fs.createReadStream(file).pipe(res)
}

export async function startServer({ app, port = 8787, host = '127.0.0.1', publicDir = PUBLIC_DIR }) {
  const server = http.createServer(async (req, res) => {
    const origin = `http://${req.headers.host || `${host}:${port}`}`
    const { pathname } = new URL(req.url, origin)
    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) return await sendResponse(res, await app.handle(await toRequest(req, origin)))
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        return res.end()
      }
      serveStatic(res, publicDir, pathname)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(err.message)
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const url = `http://${host}:${server.address().port}`
  return { url, server, close: () => new Promise((resolve) => server.close(resolve)) }
}
