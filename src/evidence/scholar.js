// Pencarian literatur ilmiah untuk tahap riset (docs/PLAN.md §19). Dikerjakan program, bukan AI: judul, tahun,
// dan abstrak diambil dari indeks ilmiah, lalu peneliti AI membacanya. Abstrak juga dipakai verifier untuk
// mengecek kutipan dari paper tanpa membuka situs penerbit (yang sering memblokir bot).
//
// Format API diambil dari dokumentasi masing-masing; belum diuji dengan API asli dari lingkungan pengembangan
// (egress diblokir). `council doctor` memeriksanya.
// - Semantic Scholar Graph API: gratis; key opsional (SEMANTIC_SCHOLAR_API_KEY, header x-api-key).
// - OpenAlex: sejak 2026 memakai key gratis (OPENALEX_API_KEY, Bearer); tanpa key kuota hariannya kecil.
// - arXiv API: gratis, Atom XML. Pedoman arXiv meminta jeda sekitar 3 detik antar-permintaan.
// Tidak ada email atau data pribadi yang dikirim.

export const SCHOLAR_SOURCES = {
  semanticscholar: { label: 'Semantic Scholar', baseURL: 'https://api.semanticscholar.org', keyEnv: 'SEMANTIC_SCHOLAR_API_KEY', gapMs: 1100, gapWithKeyMs: 1000 },
  openalex: { label: 'OpenAlex', baseURL: 'https://api.openalex.org', keyEnv: 'OPENALEX_API_KEY', gapMs: 0 },
  arxiv: { label: 'arXiv', baseURL: 'https://export.arxiv.org', gapMs: 3000, maxQueries: 3 }
}

const USER_AGENT = 'TheCouncil-Research/0.3 (+https://github.com/yearsky/thecouncil)'
export const ABSTRACT_LIMIT = 1500

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const cut = (s, max = ABSTRACT_LIMIT) => {
  const t = clean(s)
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')} …` : t
}

// Abstrak OpenAlex berbentuk inverted index: {kata: [posisi, …]}.
export function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== 'object') return ''
  const words = []
  for (const [word, positions] of Object.entries(index)) for (const p of positions || []) words[p] = word
  return clean(words.filter((w) => w !== undefined).join(' '))
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => XML_ENTITIES[name.toLowerCase()] ?? m)

const tag = (xml, name) => decodeXml(xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] || '')

export function parseSemanticScholar(data) {
  return (data?.data || []).map((p) => ({
    source: 'semanticscholar',
    title: clean(p.title),
    year: p.year || null,
    venue: clean(p.venue || p.journal?.name),
    authors: (p.authors || []).map((a) => clean(a.name)).filter(Boolean),
    citations: p.citationCount ?? null,
    doi: p.externalIds?.DOI ? String(p.externalIds.DOI).toLowerCase() : null,
    url: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : p.url || null,
    altUrls: [p.url, p.externalIds?.ArXiv ? `https://arxiv.org/abs/${p.externalIds.ArXiv}` : null].filter(Boolean),
    abstract: cut(p.abstract),
    tldr: cut(p.tldr?.text, 400)
  }))
}

export function parseOpenAlex(data) {
  return (data?.results || []).map((w) => {
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null
    const landing = w.primary_location?.landing_page_url || null
    return {
      source: 'openalex',
      title: clean(w.display_name || w.title),
      year: w.publication_year || null,
      venue: clean(w.primary_location?.source?.display_name),
      authors: (w.authorships || []).map((a) => clean(a.author?.display_name)).filter(Boolean),
      citations: w.cited_by_count ?? null,
      doi,
      url: doi ? `https://doi.org/${doi}` : landing || w.id || null,
      altUrls: [landing, w.id].filter(Boolean),
      abstract: cut(abstractFromInvertedIndex(w.abstract_inverted_index)),
      tldr: ''
    }
  })
}

export function parseArxiv(xml) {
  const entries = String(xml ?? '').match(/<entry\b[\s\S]*?<\/entry>/gi) || []
  return entries.map((e) => {
    const id = clean(tag(e, 'id'))
    const abs = id.replace(/^http:/, 'https:').replace(/v\d+$/, '')
    const doi = clean(tag(e, 'arxiv:doi')).toLowerCase() || null
    return {
      source: 'arxiv',
      title: clean(tag(e, 'title')),
      year: Number(tag(e, 'published').slice(0, 4)) || null,
      venue: 'arXiv',
      authors: (e.match(/<author\b[\s\S]*?<\/author>/gi) || []).map((a) => clean(tag(a, 'name'))).filter(Boolean),
      citations: null,
      doi,
      url: abs || null,
      altUrls: [id, doi ? `https://doi.org/${doi}` : null].filter(Boolean),
      abstract: cut(tag(e, 'summary')),
      tldr: ''
    }
  })
}

// Permintaan untuk satu sumber dan satu query.
export function requestFor(name, query, { perQuery = 5, env = process.env, baseURLs = {} } = {}) {
  const src = SCHOLAR_SOURCES[name]
  if (!src) throw new Error(`sumber literatur "${name}" tidak dikenal (${Object.keys(SCHOLAR_SOURCES).join(', ')})`)
  const base = String(baseURLs[name] || src.baseURL).replace(/\/+$/, '')
  const key = src.keyEnv ? env[src.keyEnv] : ''
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  if (name === 'semanticscholar') {
    if (key) headers['x-api-key'] = key
    const fields = 'title,year,venue,journal,authors,citationCount,externalIds,url,abstract,tldr'
    return { url: `${base}/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${perQuery}&fields=${fields}`, headers, parse: (t) => parseSemanticScholar(JSON.parse(t)) }
  }
  if (name === 'openalex') {
    if (key) headers.Authorization = `Bearer ${key}`
    const select = 'id,doi,title,display_name,publication_year,cited_by_count,abstract_inverted_index,primary_location,authorships'
    return { url: `${base}/works?search=${encodeURIComponent(query)}&per-page=${perQuery}&select=${select}`, headers, parse: (t) => parseOpenAlex(JSON.parse(t)) }
  }
  if (name === 'arxiv') {
    headers.Accept = 'application/atom+xml'
    const words = query.split(/\s+/).filter((w) => w.length > 1).slice(0, 6)
    const search = words.map((w) => `all:${encodeURIComponent(w.replace(/[():"]/g, ''))}`).join('+AND+')
    return { url: `${base}/api/query?search_query=${search}&start=0&max_results=${perQuery}`, headers, parse: parseArxiv }
  }
}

async function fetchSource(name, query, { fetchImpl = fetch, timeoutMs = 12000, ...opts } = {}) {
  const req = requestFor(name, query, opts)
  let res
  try {
    res = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const e = new Error(err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message)
    e.fatal = true
    throw e
  }
  const text = await res.text()
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}${res.status === 429 ? ' (dibatasi)' : res.status === 401 || res.status === 403 ? ' (perlu API key?)' : ''}`)
    e.status = res.status
    // Dibatasi, ditolak, atau server bermasalah: jangan lanjutkan query lain ke sumber ini.
    e.fatal = res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500
    throw e
  }
  return req.parse(text).filter((p) => p.title)
}

const titleKey = (t) =>
  String(t)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

// Gabungkan hasil yang sama (DOI atau judul), lalu urutkan: sering muncul, punya abstrak, baru, banyak disitasi.
// Urutan deterministik (seri dipecah dengan urutan pertama kali ditemukan), supaya hasil sama saat diputar ulang.
export function mergeAndRank(found, { keep = 12, now = new Date() } = {}) {
  const byKey = new Map()
  let order = 0
  for (const { paper, query } of found) {
    const keys = [paper.doi && `doi:${paper.doi}`, `t:${titleKey(paper.title)}`].filter(Boolean)
    let entry = keys.map((k) => byKey.get(k)).find(Boolean)
    if (!entry) {
      entry = { ...paper, foundIn: [], queries: [], order: order++, altUrls: [...(paper.altUrls || [])] }
    } else {
      if (!entry.abstract && paper.abstract) entry.abstract = paper.abstract
      if (!entry.tldr && paper.tldr) entry.tldr = paper.tldr
      if (!entry.doi && paper.doi) entry.doi = paper.doi
      if (!entry.venue && paper.venue) entry.venue = paper.venue
      if (paper.citations != null) entry.citations = Math.max(entry.citations ?? 0, paper.citations)
      for (const u of [paper.url, ...(paper.altUrls || [])]) if (u && u !== entry.url && !entry.altUrls.includes(u)) entry.altUrls.push(u)
    }
    if (!entry.foundIn.includes(paper.source)) entry.foundIn.push(paper.source)
    if (!entry.queries.includes(query)) entry.queries.push(query)
    for (const k of keys) byKey.set(k, entry)
  }
  const year = now.getFullYear()
  const score = (p) =>
    p.queries.length * 2 +
    p.foundIn.length +
    (p.abstract ? 2 : p.tldr ? 1 : -4) +
    (p.year ? (p.year >= year - 4 ? 2 : p.year >= year - 9 ? 1 : 0) : 0) +
    Math.log10((p.citations || 0) + 1)
  const unique = [...new Set(byKey.values())]
  return unique
    .filter((p) => p.abstract || p.tldr)
    .sort((a, b) => score(b) - score(a) || a.order - b.order)
    .slice(0, keep)
    .map(({ order: _order, ...p }, i) => ({ id: `S${i + 1}`, ...p }))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Cari semua query di semua sumber. Sumber berjalan paralel; query dalam satu sumber berurutan dengan jeda,
// sesuai batas tiap API. Kegagalan satu sumber tidak menghentikan yang lain (dicatat di `errors`).
export async function searchLiterature(queries, { sources = Object.keys(SCHOLAR_SOURCES), perQuery = 5, keep = 12, env = process.env, baseURLs = {}, fetchImpl, timeoutMs, gaps = {}, now } = {}) {
  const list = [...new Set(queries.map(clean).filter(Boolean))]
  const found = []
  const errors = []
  const stats = {}
  await Promise.all(
    sources.map(async (name) => {
      const src = SCHOLAR_SOURCES[name]
      if (!src) {
        errors.push({ source: name, message: 'sumber tidak dikenal' })
        return
      }
      const hasKey = Boolean(src.keyEnv && env[src.keyEnv])
      const gap = gaps[name] ?? (hasKey && src.gapWithKeyMs !== undefined ? src.gapWithKeyMs : src.gapMs)
      const mine = list.slice(0, src.maxQueries || list.length)
      stats[name] = { queries: 0, results: 0 }
      for (let i = 0; i < mine.length; i++) {
        if (i && gap) await sleep(gap)
        try {
          const papers = await fetchSource(name, mine[i], { perQuery, env, baseURLs, fetchImpl, timeoutMs })
          stats[name].queries++
          stats[name].results += papers.length
          for (const paper of papers) found.push({ paper, query: mine[i], source: name, at: [sources.indexOf(name), i] })
        } catch (err) {
          errors.push({ source: name, query: mine[i], message: err.message })
          if (err.fatal) break
        }
      }
    })
  )
  // Urutan gabungan tidak boleh bergantung pada sumber mana yang lebih cepat menjawab.
  found.sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0])
  return { papers: mergeAndRank(found, { keep, now }), errors, stats }
}

// Teks yang dipakai verifier untuk sumber literatur: judul + abstrak + TLDR (persis yang dibaca AI).
export const paperText = (p) => [p.title, p.abstract, p.tldr].filter(Boolean).join('\n')

// Fungsi pencarian dari config `research` (sources, perQuery, keep, baseURLs).
// `gaps` (jeda antar-permintaan per sumber, ms) hanya untuk uji; bawaannya mengikuti pedoman tiap API.
export function literatureSearcher({ sources, perQuery, keep, baseURLs, gaps } = {}, { env = process.env, fetchImpl } = {}) {
  return (queries) => searchLiterature(queries, { sources, perQuery, keep, baseURLs, gaps, env, fetchImpl })
}
