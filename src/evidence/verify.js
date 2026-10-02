// Verifier sumber (Fase 2): dicek oleh kode, bukan AI. Untuk tiap klaim yang punya URL, halaman dibuka
// lalu kutipannya dicari di teks halaman. Situs yang memblokir bot, PDF, atau timeout dicatat
// "tidak bisa dicek", bukan "salah".

export const VERIFY_STATUS = {
  verified: { icon: '✅', label: 'kutipan ditemukan' },
  quote_partial: { icon: '⚠️', label: 'kutipan mirip, tidak persis' },
  quote_not_found: { icon: '⚠️', label: 'halaman terbuka, kutipan tidak ditemukan' },
  no_quote: { icon: '⚠️', label: 'halaman terbuka, tanpa kutipan' },
  unverifiable: { icon: '❔', label: 'tidak bisa dicek otomatis' },
  unreachable: { icon: '❌', label: 'sumber tidak ada atau alamat salah' },
  no_source: { icon: '➖', label: 'klaim fakta tanpa sumber' }
}

const USER_AGENT = 'TheCouncil-Verifier/0.2 (+https://github.com/yearsky/thecouncil)'
const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

// Disamakan sebelum dibandingkan: huruf kecil, tanpa aksen, tanda kutip/strip seragam,
// "Rp9" dan "Rp 9" dianggap sama, titik/koma hanya dipertahankan di dalam angka.
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/(?<!\p{N})[.,]|[.,](?!\p{N})/gu, ' ')
    .replace(/[^\p{L}\p{N}%.,]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function trigrams(words) {
  const out = []
  for (let i = 0; i + 2 < words.length; i++) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  return out
}

// "exact" jika kutipan utuh ada di halaman; "partial" jika ≥60% trigram katanya ada; selain itu null.
export function matchQuote(quote, pageText) {
  const q = normalizeText(quote)
  if (!q) return null
  const page = normalizeText(pageText)
  if (page.includes(q)) return 'exact'
  const grams = trigrams(q.split(' '))
  if (grams.length < 2) return null
  const pageGrams = new Set(trigrams(page.split(' ')))
  const hit = grams.filter((g) => pageGrams.has(g)).length
  return hit / grams.length >= 0.6 ? 'partial' : null
}

export function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim())
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key)
    u.hostname = u.hostname.toLowerCase()
    return u.toString().replace(/\/$/, '')
  } catch {
    return String(url).trim()
  }
}

async function readLimited(res, maxBytes) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  while (size < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

export async function fetchPage(url, { timeoutMs = 15000, maxBytes = 3_000_000 } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { status: 'unreachable', detail: 'URL tidak valid' }
  }
  if (!/^https?:$/.test(parsed.protocol)) return { status: 'unreachable', detail: 'bukan alamat http(s)' }
  try {
    const res = await fetch(parsed, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'id,en;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const discard = () => res.body?.cancel().catch(() => {})
    if (res.status === 404 || res.status === 410) {
      await discard()
      return { status: 'unreachable', detail: `HTTP ${res.status}`, httpStatus: res.status }
    }
    if (!res.ok) {
      await discard()
      return { status: 'unverifiable', detail: `HTTP ${res.status}`, httpStatus: res.status }
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (type && !/^(text\/|application\/(xhtml\+xml|xml|json))/.test(type)) {
      await discard()
      return { status: 'unverifiable', detail: `jenis konten ${type} belum bisa dibaca`, httpStatus: res.status }
    }
    const body = await readLimited(res, maxBytes)
    return { ok: true, httpStatus: res.status, text: /html|xml/.test(type) || /^\s*</.test(body) ? htmlToText(body) : body }
  } catch (err) {
    if (err.name === 'TimeoutError') return { status: 'unverifiable', detail: 'timeout' }
    const code = err.cause?.code
    if (code === 'ENOTFOUND') return { status: 'unreachable', detail: 'domain tidak ditemukan' }
    return { status: 'unverifiable', detail: code || err.message }
  }
}

export function judgeClaim(claim, page) {
  if (!claim.source_url) return { status: 'no_source', detail: VERIFY_STATUS.no_source.label }
  if (!page.ok) return { status: page.status, detail: page.detail, httpStatus: page.httpStatus }
  if (!claim.quote) return { status: 'no_quote', detail: VERIFY_STATUS.no_quote.label, httpStatus: page.httpStatus }
  const match = matchQuote(claim.quote, page.text)
  if (match === 'exact') return { status: 'verified', detail: VERIFY_STATUS.verified.label, httpStatus: page.httpStatus }
  if (match === 'partial') return { status: 'quote_partial', detail: VERIFY_STATUS.quote_partial.label, httpStatus: page.httpStatus }
  return { status: 'quote_not_found', detail: VERIFY_STATUS.quote_not_found.label, httpStatus: page.httpStatus }
}

// Memverifikasi banyak klaim; halaman yang sama hanya diunduh sekali (cache dibagikan antar-ronde).
export function createVerifier({ concurrency = 4, fetcher = fetchPage, timeoutMs } = {}) {
  const pages = new Map()
  const load = (url) => {
    const key = normalizeUrl(url)
    if (!pages.has(key)) pages.set(key, fetcher(url, { timeoutMs }))
    return pages.get(key)
  }
  return async function verify(claims) {
    const results = new Map()
    const queue = [...claims]
    async function worker() {
      while (queue.length) {
        const claim = queue.shift()
        const page = claim.source_url ? await load(claim.source_url) : null
        results.set(claim.id, judgeClaim(claim, page))
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    return results
  }
}
