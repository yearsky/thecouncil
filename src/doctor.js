// `council doctor`: memeriksa tiap agen sebelum sidang (Fase 0 di docs/PLAN.md).
// Urutan per agen: terpasang / API key → uji dasar → web search. Agen diperiksa paralel.

import { agentIdsInUse, createAgent } from './agents/index.js'
import { SCHOLAR_SOURCES, searchLiterature } from './evidence/scholar.js'
import { createStyle } from './ui/style.js'

export const DOCTOR_SYSTEM =
  'Kamu sedang diuji oleh program The Council. Ikuti instruksi pengguna persis dan jawab singkat dalam Bahasa Indonesia.'
export const BASIC_PROMPT = 'Balas hanya dengan satu kata: SIAP'
export const WEB_PROMPT =
  'Gunakan pencarian web, jangan menjawab dari ingatan. Apa versi LTS terbaru Node.js saat ini? ' +
  'Jawab dalam satu kalimat, lalu tulis satu URL sumber lengkap yang diawali https://.'

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/g

export function extractUrls(text) {
  const urls = (String(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?*_`]+$/, ''))
  return [...new Set(urls)]
}

export async function checkUrl(url, { timeoutMs = 15000 } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'thecouncil-doctor' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    await res.body?.cancel()
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, status: null, error: err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message }
  }
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} dtk`
const snippet = (text, max = 160) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

async function timed(fn) {
  const start = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - start }
}

export async function checkAgent(agent, { quick = false, web = true, moderatorModel } = {}) {
  const checks = []
  const add = (name, status, detail, answer) => checks.push({ name, status, detail, ...(answer ? { answer } : {}) })
  const failed = () => checks.some((c) => c.status === 'fail')
  let model = agent.model || ''

  // 1. Terpasang (CLI) atau API key + daftar model (API)
  if (typeof agent.hasKey === 'function') {
    if (!agent.hasKey()) add('API key', 'fail', `${agent.apiKeyEnv} belum diisi di .env`)
    else {
      add('API key', 'ok', `${agent.apiKeyEnv} terisi`)
      try {
        const models = await agent.listModels()
        if (!model && models.length) {
          model = models[0]
          add('model', 'warn', `belum diisi di config; tersedia: ${models.join(', ')} (uji pakai ${model})`)
        } else if (!model) add('model', 'fail', 'belum diisi di config dan API tidak mengembalikan daftar model')
        else if (models.length && !models.includes(model)) add('model', 'fail', `"${model}" tidak ada; tersedia: ${models.join(', ')}`)
        else add('model', 'ok', model)
      } catch (err) {
        add('model', 'fail', err.message)
      }
    }
  } else {
    const version = await agent.version()
    if (version) add('terpasang', 'ok', version)
    else add('terpasang', 'fail', `perintah "${agent.bin}" tidak ditemukan atau gagal dijalankan. Sudah diinstal dan login?`)
  }
  if (quick || failed()) return summarize(agent, checks)

  // 2. Uji dasar (dan model moderator jika berbeda)
  async function basic(name, testModel) {
    try {
      const { value, ms } = await timed(() => agent.ask({ system: DOCTOR_SYSTEM, prompt: BASIC_PROMPT, model: testModel || undefined }))
      const label = value.meta?.model || testModel || 'model bawaan'
      if (/SIAP/i.test(value.text)) add(name, 'ok', `${label} · ${secs(ms)}`)
      else add(name, 'warn', `${label} · jawaban tidak sesuai`, snippet(value.text))
      return value
    } catch (err) {
      add(name, 'fail', err.message)
      return null
    }
  }
  const first = await basic('uji dasar', model)
  if (!first) return summarize(agent, checks)
  if (moderatorModel && moderatorModel !== model) await basic('uji moderator', moderatorModel)

  const { plugins = [], mcpServers = [] } = first.meta || {}
  if (plugins.length || mcpServers.length) {
    const what = [plugins.length && `plugin: ${plugins.join(', ')}`, mcpServers.length && `MCP: ${mcpServers.join(', ')}`]
      .filter(Boolean)
      .join('; ')
    const restricted = agent.extraArgs?.includes('--restricted')
      ? '--restricted sudah dipakai, tapi tetap termuat'
      : '--restricted bisa dicoba lewat "extraArgs" (efeknya belum pasti)'
    add('catatan', 'info', `ikut termuat (${what}); bisa menambah konteks dan kuota tiap panggilan. ${restricted}`)
  }

  // 3. Web search
  if (!web) add('web search', 'skip', 'dilewati (--no-web)')
  else if (!agent.capabilities.webSearch) add('web search', 'skip', 'tidak ada bawaan; di Fase 2 diberi paket bukti dari agen lain')
  else {
    try {
      const { value, ms } = await timed(() => agent.ask({ system: DOCTOR_SYSTEM, prompt: WEB_PROMPT, webSearch: true, model: model || undefined }))
      const urls = extractUrls(value.text)
      const toolUses = value.meta?.toolUses
      const answer = snippet(value.text)
      if (Array.isArray(value.meta?.tools) && !value.meta.tools.includes('WebSearch')) {
        add('web search', 'fail', 'tool WebSearch tidak tersedia di sesi ini', answer)
      } else if (value.meta?.searchFallback) {
        add('web search', 'warn', `endpoint menolak tool web search, dijawab tanpa pencarian (${value.meta.searchFallback})`, answer)
      } else if (!urls.length) {
        add('web search', 'warn', `tidak ada URL di jawaban · ${secs(ms)}`, answer)
      } else {
        const page = await checkUrl(urls[0])
        const reach = page.ok ? `HTTP ${page.status}` : `tidak bisa dibuka (${page.status ? `HTTP ${page.status}` : page.error})`
        let status = page.ok ? 'ok' : 'warn'
        let note = ''
        if (toolUses && !toolUses.WebSearch && !toolUses.WebFetch && !toolUses.web_search) {
          status = 'warn'
          note = ' · tool web tidak dipanggil, URL mungkin dari ingatan'
        } else if (!toolUses) note = ' · cek jawabannya: tidak bisa dipastikan pencarian benar-benar dilakukan'
        add('web search', status, `${urls[0]} → ${reach} · ${secs(ms)}${note}`, answer)
      }
    } catch (err) {
      add('web search', 'fail', err.message)
    }
  }
  return summarize(agent, checks)
}

function summarize(agent, checks) {
  const status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
  return { id: agent.id, label: agent.label, type: agent.type, status, checks }
}

// Sumber literatur tahap riset: satu pencarian kecil per sumber (tanpa AI, jadi juga ikut di --quick).
// Tidak pernah "fail": tanpa literatur, sidang tetap jalan dan peneliti hanya memakai web.
export async function checkLiterature(research = {}, { env = process.env, fetchImpl } = {}) {
  const checks = await Promise.all(
    (research.sources || Object.keys(SCHOLAR_SOURCES)).map(async (name) => {
      const src = SCHOLAR_SOURCES[name]
      if (!src) return { name, status: 'warn', detail: 'sumber tidak dikenal' }
      const key = src.keyEnv ? (env[src.keyEnv] ? ` · ${src.keyEnv} terisi` : ` · tanpa ${src.keyEnv} (opsional)`) : ''
      const { value: r, ms } = await timed(() =>
        searchLiterature(['smallholder farmer credit scoring'], { sources: [name], perQuery: 2, keep: 2, baseURLs: research.baseURLs, gaps: { [name]: 0 }, env, fetchImpl })
      )
      if (r.errors.length) return { name: src.label, status: 'warn', detail: `${r.errors[0].message}${key}` }
      const found = r.stats[name]?.results || 0
      return { name: src.label, status: found ? 'ok' : 'warn', detail: `${found ? `${found} hasil` : 'tidak ada hasil'} · ${secs(ms)}${key}` }
    })
  )
  const status = checks.every((c) => c.status === 'ok') ? 'ok' : 'warn'
  return { id: 'literatur', label: 'Riset literatur', type: 'indeks ilmiah', status, checks }
}

export async function runDoctor(config, { quick = false, web = true, only, makeAgent = createAgent, literature = checkLiterature } = {}) {
  const lit = !only && config.research?.enabled && literature ? literature(config.research) : null
  const ids = only ? [only] : agentIdsInUse(config)
  const results = await Promise.all(
    ids.map(async (id) => {
      const cfg = config.agents[id]
      const isModerator = config.moderator.agent === id
      const inPanel = config.panel.includes(id)
      // Agen yang hanya jadi moderator diuji dengan model moderator sebagai model utamanya.
      const agentCfg = isModerator && !inPanel && config.moderator.model ? { ...cfg, model: config.moderator.model } : cfg
      let agent
      try {
        agent = makeAgent(id, agentCfg)
      } catch (err) {
        return { id, label: id, type: cfg?.type, status: 'fail', checks: [{ name: 'config', status: 'fail', detail: err.message }] }
      }
      const moderatorModel = isModerator && inPanel ? config.moderator.model : undefined
      return checkAgent(agent, { quick, web, moderatorModel })
    })
  )
  return { ok: results.every((r) => r.status !== 'fail'), results, ...(lit ? { literature: await lit } : {}) }
}

// "info" dan "skip" tidak memengaruhi status agen.
const ICON = { ok: '✔', warn: '⚠', fail: '✖', skip: '–', info: '•' }

export function formatDoctor(report, { style = createStyle(), source } = {}) {
  const paint = { ok: style.green, warn: style.yellow, fail: style.red, skip: style.dim, info: style.cyan }
  const lines = [style.bold('The Council — doctor'), style.dim(`Config: ${source || 'bawaan (council.config.json belum ada)'}`), '']
  for (const r of [...report.results, ...(report.literature ? [report.literature] : [])]) {
    lines.push(`${paint[r.status](ICON[r.status])} ${style.bold(r.label)} ${style.dim(`(${r.type})`)}`)
    const width = Math.max(...r.checks.map((c) => c.name.length))
    for (const c of r.checks) {
      lines.push(`  ${paint[c.status](ICON[c.status])} ${c.name.padEnd(width)}  ${c.detail}`)
      if (c.answer) lines.push(style.dim(`    ↳ "${c.answer}"`))
    }
    lines.push('')
  }
  const count = (s) => report.results.filter((r) => r.status === s).length
  const parts = [`${count('ok')} siap`, count('warn') && `${count('warn')} dengan peringatan`, count('fail') && `${count('fail')} bermasalah`]
  lines.push(`Hasil: ${parts.filter(Boolean).join(', ')}.`)
  return lines.join('\n')
}
