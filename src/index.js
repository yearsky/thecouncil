#!/usr/bin/env node
// The Council: sidang debat beberapa agen AI dari terminal. Lihat docs/PLAN.md.

import { parseArgs } from 'node:util'
import { createAgents } from './agents/index.js'
import { applyRunOptions, loadConfig, loadEnv, validateConfig } from './config.js'
import { runCouncil } from './council/protocol.js'
import { buildReport } from './council/report.js'
import { createVerifier } from './evidence/verify.js'
import { formatDoctor, runDoctor } from './doctor.js'
import { memoryFromResult } from './council/memory.js'
import { createSession, readMemory } from './store/session.js'
import { createTerminalRenderer } from './ui/terminal.js'

const HELP = `The Council — sidang debat agen AI

Pemakaian:
  council run "<topik>" [opsi]   Mulai sidang
  council doctor [opsi]          Periksa tiap agen (terpasang, login, uji dasar, web search)
  council ui [--port <n>]        Buka UI web di PC sendiri (http://127.0.0.1:8787); bisa memakai Claude/Codex

Opsi run:
  --rounds <n>                   Maks. ronde debat sebelum suara akhir (bawaan dari config: 3)
  --consensus <bulat|mayoritas>  Kapan sidang boleh berhenti lebih awal (unanimous|majority)
  --panel <id,id,...>            Panelis, mis. --panel claude-opus,claude-haiku
  --moderator <id>               Agen moderator
  --moderator-model <model>      Model moderator, mis. opus
  --model <id=model>             Ganti model satu agen (boleh berulang), mis. --model claude=haiku
  --no-web                       Matikan web search
  --search-budget <n>            Maks. pencarian web per panelis per ronde (bawaan 3, 0 = tanpa batas)
  --no-verify                    Jangan periksa sumber klaim
  --lanjut <folder sesi>         Lanjutkan dari sidang lama: kesimpulan + klaim ✅-nya ikut (boleh berulang)
  --effort <tahap=level>         Effort Claude per tahap (frame|panel|judge|vote|repair = low..max), boleh berulang
  --json                         Cetak event JSON per baris (untuk bot WhatsApp)

Opsi doctor:
  --quick                        Hanya cek terpasang / API key (tanpa memakai kuota AI)
  --no-web                       Lewati uji web search
  --agent <id>                   Periksa satu agen saja, mis. --agent codex
  --json                         Cetak hasil sebagai JSON

Opsi ui:
  --port <n>                     Port lokal (bawaan 8787). Sidang disimpan di memori proses: hilang saat UI ditutup.
                                 Isi COUNCIL_PASSWORD di .env kalau ingin UI lokal memakai password.

Umum:
  -c, --config <file>            File config (bawaan: council.config.json)
  -h, --help                     Tampilkan bantuan ini`

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  agent: { type: 'string' },
  quick: { type: 'boolean' },
  'no-web': { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  'search-budget': { type: 'string' },
  effort: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  rounds: { type: 'string' },
  consensus: { type: 'string' },
  panel: { type: 'string' },
  moderator: { type: 'string' },
  'moderator-model': { type: 'string' },
  model: { type: 'string', multiple: true },
  lanjut: { type: 'string', multiple: true },
  port: { type: 'string' },
  help: { type: 'boolean', short: 'h' }
}

function readConfig(values) {
  loadEnv()
  return loadConfig({ file: values.config })
}

async function doctor(values) {
  const config = readConfig(values)
  const errors = validateConfig(config)
  if (values.agent && !Object.hasOwn(config.agents, values.agent)) errors.push(`agen "${values.agent}" tidak ada di config`)
  if (errors.length) {
    console.error(`Config tidak valid:\n- ${errors.join('\n- ')}`)
    return 1
  }
  if (!values.json && !values.quick) console.log('Memeriksa agen… (memakai sedikit kuota; bisa 1–3 menit)\n')
  const report = await runDoctor(config, { quick: values.quick, web: !values['no-web'], only: values.agent })
  console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctor(report, { source: config.source }))
  return report.ok ? 0 : 1
}

async function run(values, topicParts) {
  const topic = topicParts.join(' ').trim()
  if (!topic) {
    console.error('Topik sidang kosong. Contoh: council run "Ide hackathon tentang keuangan UMKM"')
    return 2
  }
  const { config, errors } = applyRunOptions(readConfig(values), values)
  errors.push(...validateConfig(config))
  if (errors.length) {
    console.error(`Config tidak valid:\n- ${errors.join('\n- ')}`)
    return 1
  }

  let memory
  try {
    memory = (values.lanjut || []).map((dir) => readMemory(dir, { baseDir: config.sessionsDir || 'sessions' }))
  } catch (err) {
    console.error(`--lanjut: ${err.message}`)
    return 1
  }
  const agents = createAgents(config)
  const session = createSession({ topic, baseDir: config.sessionsDir || 'sessions' })
  const renderer = values.json ? null : createTerminalRenderer()
  const emit = (event) => {
    session.append(event)
    if (values.json) process.stdout.write(JSON.stringify(event) + '\n')
    else renderer.handle(event)
  }

  try {
    const result = await runCouncil({
      topic,
      panel: config.panel.map((id) => agents[id]),
      moderator: { agent: agents[config.moderator.agent], model: config.moderator.model || undefined },
      maxRounds: config.maxRounds,
      consensus: config.consensus,
      web: config.web,
      searchBudget: config.searchBudget,
      devilsAdvocate: config.devilsAdvocate,
      effort: config.effort,
      verify: config.verify ? createVerifier() : null,
      memory,
      emit,
      finalize: async (res) => {
        session.writeReport(buildReport(res))
        session.writeMemory(memoryFromResult(res, { id: session.id }))
        return { session: session.id, report: session.reportPath }
      }
    })
    return result.status === 'error' ? 1 : 0
  } finally {
    renderer?.close()
  }
}

async function ui(values) {
  const config = readConfig(values)
  const errors = validateConfig(config)
  const port = values.port === undefined ? 8787 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push('--port harus angka 0–65535')
  if (errors.length) {
    console.error(`Config tidak valid:\n- ${errors.join('\n- ')}`)
    return 1
  }
  const { createApp } = await import('./cloud/app.js')
  const { startServer } = await import('./server.js')
  const { memoryKv } = await import('./store/kv.js')
  const app = createApp({
    kv: memoryKv(),
    config,
    allowCli: true,
    requireAuth: Boolean(process.env.COUNCIL_PASSWORD),
    secureCookie: false,
    // Di PC sendiri tidak ada batas durasi fungsi, jadi sidang berjalan dalam satu slice.
    limits: { maxDurationMs: Infinity, callTimeoutMs: Infinity, dailyRuns: Infinity }
  })
  const { url } = await startServer({ app, port })
  console.log(`The Council UI: ${url}`)
  console.log(`Config: ${config.source || 'bawaan (council.config.json belum ada)'} · tekan Ctrl+C untuk berhenti`)
  return new Promise(() => {})
}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`)
    return 2
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  if (values.help || !command || command === 'help') {
    console.log(HELP)
    return 0
  }
  switch (command) {
    case 'doctor':
      return doctor(values)
    case 'run':
      return run(values, rest)
    case 'ui':
      return ui(values)
    default:
      console.error(`Perintah tidak dikenal: ${command}\n\n${HELP}`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(err.message)
    process.exitCode = 1
  }
)
