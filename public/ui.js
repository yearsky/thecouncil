// Helper bersama UI The Council (app.js dan run-view.js). Semua teks dari model dimasukkan sebagai teks
// (bukan HTML), kecuali Markdown yang dirender md() setelah di-escape.

export const $ = (sel) => document.querySelector(sel)
export const POLL_MS = 2500

export const VOTE = { AGREE: ['✔ setuju', 'ok'], AGREE_WITH_RESERVATIONS: ['◐ setuju dengan catatan', 'warn'], DISAGREE: ['✖ tidak setuju', 'bad'] }
export const STATUS = {
  unanimous: ['✔ bulat', 'ok'],
  majority: ['◐ mayoritas', 'warn'],
  no_consensus: ['✖ tidak ada konsensus', 'bad'],
  error: ['✖ gagal', 'bad'],
  running: ['berjalan', 'info'],
  finished: ['selesai', 'ok'],
  cancelled: ['dibatalkan', 'warn']
}
// Sama dengan VERIFY_STATUS di src/evidence/verify.js.
export const VERIFY = {
  verified: ['✅', 'kutipan ditemukan'],
  quote_partial: ['⚠️', 'kutipan mirip, tidak persis'],
  quote_not_found: ['⚠️', 'halaman terbuka, kutipan tidak ditemukan'],
  no_quote: ['⚠️', 'halaman terbuka, tanpa kutipan'],
  unverifiable: ['❔', 'tidak bisa dicek otomatis'],
  unreachable: ['❌', 'sumber tidak ada atau alamat salah'],
  no_source: ['➖', 'klaim fakta tanpa sumber']
}
export const FLAG = {
  contradictory_vote: 'menyatakan setuju tapi menulis keberatan pemblokir (dihitung tidak setuju)',
  unexplained_flip: 'suara berubah tanpa penjelasan',
  change_without_reason: 'berubah pendapat tanpa menyebut alasan',
  unknown_citation: 'merujuk ID klaim yang tidak ada'
}

// ---------- utilitas DOM ----------

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export const badge = ([text, tone]) => el('span', { class: `badge ${tone || ''}` }, text)
export const secs = (ms) => `${(ms / 1000).toFixed(1)} dtk`
export const num = (n) => Math.round(n || 0).toLocaleString('id-ID')
export const time = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '')

// Markdown kecil yang aman: teks di-escape dulu, lalu hanya pola sederhana yang diubah.
export function md(source) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  const lines = String(source || '').split('\n')
  const out = []
  let list = null
  let para = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flushPara()
      closeList()
      const code = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushPara()
      closeList()
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(line)
      i++
      const rows = []
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]))
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      )
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      closeList()
      const level = Math.min(6, heading[1].length + 2)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const item = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/)
    if (item) {
      flushPara()
      const type = /\d/.test(item[1]) ? 'ol' : 'ul'
      if (list !== type) {
        closeList()
        out.push(`<${type}>`)
        list = type
      }
      out.push(`<li>${inline(item[2])}</li>`)
      continue
    }
    if (!line.trim()) {
      flushPara()
      closeList()
      continue
    }
    closeList()
    para.push(line.trim())
  }
  flushPara()
  closeList()
  const box = el('div', { class: 'md' })
  box.innerHTML = out.join('\n')
  return box
}

// ---------- API ----------

// Rute dikirim lewat ?path= (bukan /api/<rute>), karena di Vercel rewrite /api/<rute> tidak sampai ke fungsi.
export const apiUrl = (path) => `/api?path=${encodeURIComponent(path)}`

// Dipanggil saat server menjawab 401 (sesi login habis); app.js memasang handler yang menampilkan form login.
let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  })
  const type = res.headers.get('content-type') || ''
  const data = type.includes('json') ? await res.json() : await res.text()
  if (res.status === 401 && path !== 'login') {
    onUnauthorized()
    throw new Error('belum login')
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.data = data
    throw err
  }
  return data
}
