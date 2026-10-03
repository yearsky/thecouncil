// API HTTP The Council (handler Web-standard Request → Response). Dipakai oleh fungsi Vercel (api/index.js)
// dan oleh `council ui` di PC sendiri (src/server.js). Lihat docs/PLAN.md §18.
//
// Rute (semua di bawah /api):
//   GET  health                    status singkat (tanpa login)
//   POST login | logout, GET me     login password → cookie
//   GET  config                    panel, moderator, dan pilihan bawaan
//   GET  models                    daftar model dari API (GET /models)
//   GET  doctor | doctor/quick     cek agen (versi lengkap memakai sedikit token)
//   GET  runs, POST runs            daftar sidang / sidang baru
//   GET  runs/:id/events/:after    event setelah nomor `after`; sekaligus melanjutkan sidang yang dijeda
//   POST runs/:id/cancel
//   GET  runs/:id/report           laporan Markdown
//   GET  memories                  sidang selesai yang bisa dilanjutkan

import { createAgents } from '../agents/index.js'
import { CONSENSUS_MODES } from '../council/consensus.js'
import { runDoctor } from '../doctor.js'
import { createVerifier } from '../evidence/verify.js'
import { clearSessionCookie, makeSessionCookie, readCookie, safeEqual, sessionSecret, validBearer, validSession } from './auth.js'
import { runConfigErrors } from './config.js'
import { ACTIVE_KEY, createRun, makeRunId, parseActive, readEvents, readMemory, readMeta, runKey, runSlice } from './runner.js'

export const DEFAULT_LIMITS = {
  // Batas durasi fungsi Vercel (Hobby, Fluid compute: 300 dtk). Panggilan baru hanya dimulai kalau masih ada
  // waktu untuk satu panggilan penuh (callTimeoutMs) plus margin.
  maxDurationMs: 300000,
  callTimeoutMs: 180000,
  marginMs: 20000,
  dailyRuns: 10,
  maxTopicChars: 4000
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

async function body(request) {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'body harus JSON')
  }
}

// UI dan bot memanggil /api?path=<rute>: query string pada request langsung ke /api pasti sampai ke fungsi.
// Path langsung (/api/<rute>) tetap diterima untuk `council ui` dan untuk rewrite di vercel.json; di Vercel,
// rewrite itu ternyata tidak membawa rutenya ke fungsi (login gagal dengan "belum login", 3 Okt 2026).
export function routeOf(request) {
  const url = new URL(request.url)
  const fromQuery = url.searchParams.get('path')
  const route = fromQuery !== null ? fromQuery : url.pathname.replace(/^\/api(\/index(\.js)?)?(\/|$)/, '')
  return route.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent)
}

// Rute yang butuh login. Rute lain dijawab 404 sebelum pengecekan login, supaya alamat yang salah tidak
// menyamar jadi "belum login".
function knownRoute(method, [head, id, sub]) {
  if (head === 'runs') {
    if (!id) return method === 'GET' || method === 'POST'
    return (method === 'GET' && (sub === 'events' || sub === 'report')) || (method === 'POST' && sub === 'cancel')
  }
  return method === 'GET' && ['config', 'models', 'doctor', 'memories'].includes(head)
}

const seenUrl = (request) => {
  const url = new URL(request.url)
  return `${url.pathname}${url.search}`
}

function runSummary(meta, active = false) {
  return {
    id: meta.id,
    topic: meta.topic,
    status: meta.status,
    active,
    createdAt: meta.createdAt,
    finishedAt: meta.finishedAt || null,
    slices: meta.slices,
    error: meta.error || null,
    memory: (meta.memory || []).map((m) => ({ id: m.id, question: m.question })),
    panel: meta.config.panel.map((id) => ({ id, label: meta.config.agents[id].label || id, model: meta.config.agents[id].model || null })),
    moderator: { id: meta.config.moderator.agent, model: meta.config.moderator.model || meta.config.agents[meta.config.moderator.agent].model || null }
  }
}

export function createApp({
  kv,
  config,
  env = process.env,
  waitUntil = (promise) => promise,
  // Batas waktu invocation dari platform (Vercel: getDeadline()). Kalau ada, dipakai ganti maxDurationMs.
  deadline = () => undefined,
  allowCli = false,
  requireAuth = true,
  secureCookie = true,
  limits: limitOverrides = {},
  makeAgents,
  makeVerifier = () => createVerifier(),
  makeLiterature,
  doctor = runDoctor,
  now = () => new Date(),
  log = console
}) {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides }
  const startWindowMs = Number.isFinite(limits.maxDurationMs) ? Math.max(10000, limits.maxDurationMs - limits.callTimeoutMs - limits.marginMs) : Infinity
  const lockTtlSec = Number.isFinite(limits.maxDurationMs) ? Math.ceil(limits.maxDurationMs / 1000) + 30 : 6 * 3600

  // Timeout tiap agen tidak boleh lebih lama dari satu panggilan yang muat di satu slice.
  // Tanpa batas (council ui di PC sendiri), timeout bawaan tiap agen dipakai apa adanya.
  const agentsFor = (cfg) => {
    const clamp = (a) => (Number.isFinite(limits.callTimeoutMs) ? { ...a, timeoutMs: Math.min(a.timeoutMs || limits.callTimeoutMs, limits.callTimeoutMs) } : a)
    const clamped = { ...cfg, agents: Object.fromEntries(Object.entries(cfg.agents).map(([id, a]) => [id, clamp(a)])) }
    return makeAgents ? makeAgents(clamped) : createAgents(clamped)
  }

  function kick(id) {
    const end = deadline()?.getTime()
    const window = end ? Math.max(10000, end - Date.now() - limits.callTimeoutMs - limits.marginMs) : startWindowMs
    const task = runSlice(kv, id, { makeAgents: agentsFor, makeVerifier, ...(makeLiterature ? { makeLiterature } : {}), startWindowMs: window, lockTtlSec }).catch((err) => log.error(`[council] slice ${id} gagal: ${err.message}`))
    waitUntil(task)
    return task
  }

  function authorized(request) {
    if (!requireAuth) return true
    if (validBearer(request, env.COUNCIL_API_TOKEN)) return true
    return validSession(sessionSecret(env), readCookie(request))
  }

  async function login(request) {
    if (!env.COUNCIL_PASSWORD) throw new HttpError(503, 'COUNCIL_PASSWORD belum diisi di environment')
    const ip = (request.headers.get('x-forwarded-for') || 'lokal').split(',')[0].trim()
    const failKey = `login-fail:${ip}`
    if (Number((await kv.get(failKey)) || 0) >= 10) throw new HttpError(429, 'terlalu banyak percobaan login; coba lagi 15 menit lagi')
    const { password } = await body(request)
    if (!safeEqual(password || '', env.COUNCIL_PASSWORD)) {
      await kv.incr(failKey)
      await kv.expire(failKey, 900)
      throw new HttpError(401, 'password salah')
    }
    return json(200, { ok: true }, { 'Set-Cookie': makeSessionCookie(sessionSecret(env), { secure: secureCookie }) })
  }

  async function models() {
    const cached = await kv.get('models')
    if (cached) return JSON.parse(cached)
    const lister = Object.values(agentsFor(config)).find((a) => typeof a.listModels === 'function')
    if (!lister) return []
    const list = await lister.listModels()
    await kv.set('models', JSON.stringify(list), { ex: 3600 })
    return list
  }

  async function newRun(request) {
    const input = await body(request)
    const topic = String(input.topic || '').trim()
    if (!topic) throw new HttpError(400, 'topik sidang kosong')
    if (topic.length > limits.maxTopicChars) throw new HttpError(400, `topik terlalu panjang (maks. ${limits.maxTopicChars} karakter)`)

    const cfg = { ...config, moderator: { ...config.moderator }, research: { ...config.research }, agents: { ...config.agents } }
    if (input.maxRounds !== undefined) {
      const n = Number(input.maxRounds)
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new HttpError(400, 'jumlah ronde harus 1–10')
      cfg.maxRounds = n
    }
    if (input.consensus !== undefined) {
      if (!CONSENSUS_MODES.includes(input.consensus)) throw new HttpError(400, 'aturan konsensus harus unanimous atau majority')
      cfg.consensus = input.consensus
    }
    if (input.web !== undefined) cfg.web = Boolean(input.web)
    if (input.verify !== undefined) cfg.verify = Boolean(input.verify)
    if (input.research !== undefined) cfg.research.enabled = Boolean(input.research)
    for (const [id, model] of Object.entries(input.models || {})) {
      if (!cfg.panel.includes(id) && cfg.moderator.agent !== id) throw new HttpError(400, `agen "${id}" tidak ada di panel`)
      cfg.agents[id] = { ...cfg.agents[id], model: String(model) }
    }
    if (input.moderatorModel !== undefined) cfg.moderator.model = String(input.moderatorModel)
    const errors = runConfigErrors(cfg, { allowCli })
    if (errors.length) throw new HttpError(400, errors.join('; '))

    const memory = []
    for (const id of input.memory || []) {
      const m = await readMemory(kv, String(id))
      if (!m) throw new HttpError(400, `memori sidang "${id}" tidak ada (sidang belum selesai?)`)
      memory.push(m)
    }

    const created = now()
    const id = makeRunId(topic, created)
    await claimSlot(id)
    let meta
    try {
      const day = created.toISOString().slice(0, 10)
      const used = Number((await kv.get(`quota:${day}`)) || 0)
      if (used >= limits.dailyRuns) throw new HttpError(429, `batas ${limits.dailyRuns} sidang per hari tercapai`)
      await kv.incr(`quota:${day}`)
      await kv.expire(`quota:${day}`, 2 * 86400)
      meta = await createRun(kv, { id, topic, config: cfg, memory, now: created })
    } catch (err) {
      await releaseSlot(id)
      throw err
    }
    kick(meta.id)
    return json(201, { run: runSummary(meta, true) })
  }

  // Hanya satu sidang berjalan pada satu waktu. Slot diklaim dengan SET NX (atomik), jadi dua permintaan
  // bersamaan tidak bisa sama-sama lolos. Nilai slot memuat waktu klaim: pemegang yang meta sidangnya belum ada
  // dianggap sedang dibuat (bukan basi) selama STARTING_MS. Pemegang yang sidangnya sudah berhenti boleh
  // digantikan, tapi hanya oleh satu permintaan (kunci "active-clear:<nilai slot>").
  const STARTING_MS = 120000

  async function claimSlot(id) {
    const value = `${id}|${now().getTime()}`
    if (await kv.set(ACTIVE_KEY, value, { nx: true })) return
    const current = await kv.get(ACTIVE_KEY)
    const holder = parseActive(current)
    if (holder) {
      const meta = await readMeta(kv, holder.id)
      const starting = !meta && now().getTime() - holder.at < STARTING_MS
      if (meta?.status === 'running' || starting) throw new HttpError(409, 'masih ada sidang yang berjalan; tunggu selesai atau batalkan dulu', { active: holder.id })
      if (!(await kv.set(`active-clear:${current}`, id, { nx: true, ex: 60 }))) throw new HttpError(409, 'sidang lain sedang dimulai; coba lagi sebentar')
      if ((await kv.get(ACTIVE_KEY)) === current) await kv.del(ACTIVE_KEY)
    }
    if (!(await kv.set(ACTIVE_KEY, value, { nx: true }))) throw new HttpError(409, 'sidang lain sedang dimulai; coba lagi sebentar')
  }

  async function releaseSlot(id) {
    if (parseActive(await kv.get(ACTIVE_KEY))?.id === id) await kv.del(ACTIVE_KEY)
  }

  async function events(id, after) {
    const meta = await readMeta(kv, id)
    if (!meta) throw new HttpError(404, 'sidang tidak ditemukan')
    let active = await kv.exists(runKey(id, 'lock'))
    // Sidang yang dijeda dilanjutkan oleh siapa pun yang membukanya (browser atau bot).
    if (meta.status === 'running' && !active) {
      kick(id)
      active = true
    }
    const list = await readEvents(kv, id, after)
    return json(200, { run: runSummary(meta, active), events: list, next: after + list.length })
  }

  async function listRuns(onlyFinished = false) {
    const ids = await kv.lrange('runs', 0, 49)
    const metas = (await Promise.all(ids.map((id) => readMeta(kv, id)))).filter(Boolean)
    return metas.filter((m) => !onlyFinished || m.status === 'finished').map((m) => runSummary(m))
  }

  async function route(request) {
    const parts = routeOf(request)
    const [head, id, sub, arg] = parts
    const method = request.method
    const unknown = () => new HttpError(404, `rute tidak dikenal: ${method} /api/${parts.join('/')} (diterima: ${seenUrl(request)})`)
    if (method === 'GET' && head === 'health') return json(200, { ok: true, kv: kv.kind, auth: requireAuth ? Boolean(env.COUNCIL_PASSWORD) : 'lokal', route: parts.join('/') })
    if (method === 'POST' && head === 'login') return login(request)
    if (method === 'POST' && head === 'logout') return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secureCookie) })
    if (method === 'GET' && head === 'me') return json(200, { loggedIn: authorized(request), authRequired: requireAuth })

    if (!knownRoute(method, parts)) throw unknown()
    if (!authorized(request)) throw new HttpError(401, 'belum login')

    if (method === 'GET' && head === 'config') {
      const agent = (aid) => ({ id: aid, label: config.agents[aid].label || aid, type: config.agents[aid].type, model: config.agents[aid].model || '' })
      return json(200, {
        panel: config.panel.map(agent),
        moderator: { ...agent(config.moderator.agent), model: config.moderator.model || '' },
        defaults: {
          maxRounds: config.maxRounds,
          consensus: config.consensus,
          web: config.web,
          verify: config.verify,
          research: Boolean(config.research?.enabled),
          searchBudget: config.searchBudget
        },
        limits: { dailyRuns: limits.dailyRuns, maxTopicChars: limits.maxTopicChars }
      })
    }
    if (method === 'GET' && head === 'models') return json(200, { models: await models() })
    if (method === 'GET' && head === 'doctor') {
      const report = await doctor(config, { quick: id === 'quick', makeAgent: (aid, cfg) => agentsFor({ ...config, panel: [aid], moderator: { agent: aid }, agents: { [aid]: cfg } })[aid] })
      return json(200, report)
    }
    if (head === 'runs' && !id) {
      if (method === 'GET') return json(200, { runs: await listRuns() })
      if (method === 'POST') return newRun(request)
    }
    if (head === 'runs' && id) {
      if (method === 'GET' && sub === 'events') {
        const after = Number(arg || 0)
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'nomor event tidak valid')
        return events(id, after)
      }
      if (method === 'POST' && sub === 'cancel') {
        const meta = await readMeta(kv, id)
        if (!meta) throw new HttpError(404, 'sidang tidak ditemukan')
        if (meta.status !== 'running') return json(200, { run: runSummary(meta) })
        await kv.set(runKey(id, 'cancel'), '1')
        if (!(await kv.exists(runKey(id, 'lock')))) kick(id)
        return json(202, { run: runSummary(meta, true) })
      }
      if (method === 'GET' && sub === 'report') {
        const md = await kv.get(runKey(id, 'report'))
        if (!md) throw new HttpError(404, 'laporan belum ada (sidang belum selesai?)')
        return new Response(md, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.md"`, 'Cache-Control': 'no-store' } })
      }
    }
    if (method === 'GET' && head === 'memories') return json(200, { runs: await listRuns(true) })
    throw unknown()
  }

  return {
    kick,
    async handle(request) {
      try {
        return await route(request)
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra })
        log.error(`[council] ${request.method} ${request.url}: ${err.stack || err.message}`)
        return json(500, { error: err.message })
      }
    }
  }
}
