#!/usr/bin/env node
// The Council: sidang debat beberapa agen AI dari terminal. Lihat docs/PLAN.md.

import { parseArgs } from 'node:util'
import { loadConfig, loadEnv, validateConfig } from './config.js'
import { formatDoctor, runDoctor } from './doctor.js'

const HELP = `The Council — sidang debat agen AI

Pemakaian:
  council doctor [opsi]     Periksa tiap agen (terpasang, login, uji dasar, web search)
  council run "<topik>"     Mulai sidang (belum tersedia, dikerjakan di Fase 1)

Opsi doctor:
  --quick                   Hanya cek terpasang / API key (tanpa memakai kuota AI)
  --no-web                  Lewati uji web search
  --agent <id>              Periksa satu agen saja, mis. --agent codex
  --json                    Cetak hasil sebagai JSON
  -c, --config <file>       File config (bawaan: council.config.json)
  -h, --help                Tampilkan bantuan ini`

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  agent: { type: 'string' },
  quick: { type: 'boolean' },
  'no-web': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
}

async function doctor(values) {
  loadEnv()
  const config = loadConfig({ file: values.config })
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

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`)
    return 2
  }
  const { values, positionals } = parsed
  const [command] = positionals
  if (values.help || !command || command === 'help') {
    console.log(HELP)
    return 0
  }
  switch (command) {
    case 'doctor':
      return doctor(values)
    case 'run':
      console.error('Perintah "run" belum tersedia; dikerjakan di Fase 1 (docs/PLAN.md). Jalankan "council doctor" dulu.')
      return 1
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
