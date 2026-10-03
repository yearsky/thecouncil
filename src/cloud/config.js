// Config untuk mode server (Vercel). Hanya agen API (bayar per token) yang boleh dipakai di server; agen CLI
// memakai login langganan dan hanya untuk PC sendiri (docs/PLAN.md K7).

import { CLI_TYPES } from '../agents/index.js'
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../config.js'

const deepseek = (label) => ({
  type: 'anthropic-compatible',
  label,
  baseURL: 'https://api.deepseek.com/anthropic',
  modelsURL: 'https://api.deepseek.com',
  model: '',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  timeoutMs: 180000,
  maxTokens: 32000
})

// Sama dengan examples/deepseek-only.json. Model dipilih di UI dari daftar GET /models.
export const CLOUD_CONFIG = {
  moderator: { agent: 'deepseek-pro', model: '' },
  panel: ['deepseek-pro', 'deepseek-flash', 'deepseek-flash-b'],
  maxRounds: 3,
  consensus: 'unanimous',
  agents: {
    'deepseek-pro': deepseek('DeepSeek Pro'),
    'deepseek-flash': deepseek('DeepSeek Flash'),
    'deepseek-flash-b': deepseek('DeepSeek Flash (B)')
  }
}

// COUNCIL_CONFIG (JSON di env Vercel) menggantikan config bawaan di atas.
export function cloudConfig(env = process.env) {
  let user = CLOUD_CONFIG
  if (env.COUNCIL_CONFIG) {
    try {
      user = JSON.parse(env.COUNCIL_CONFIG)
    } catch (err) {
      throw new Error(`COUNCIL_CONFIG bukan JSON yang valid: ${err.message}`)
    }
  }
  return mergeConfig(DEFAULT_CONFIG, user)
}

// Masalah config untuk satu sidang: agen CLI di server, atau model yang belum dipilih.
export function runConfigErrors(config, { allowCli = false } = {}) {
  const errors = validateConfig(config)
  if (errors.length) return errors
  const isCli = (id) => CLI_TYPES.includes(config.agents[id].type)
  const name = (id) => config.agents[id].label || id
  for (const id of new Set([config.moderator.agent, ...config.panel])) {
    if (!allowCli && isCli(id)) errors.push(`agen "${id}" (${config.agents[id].type}) memakai login langganan dan hanya bisa dijalankan di PC sendiri, bukan di server`)
  }
  for (const id of config.panel) if (!isCli(id) && !config.agents[id].model) errors.push(`model untuk ${name(id)} belum dipilih`)
  const mod = config.moderator.agent
  if (!isCli(mod) && !(config.moderator.model || config.agents[mod].model)) errors.push(`model untuk moderator (${name(mod)}) belum dipilih`)
  return errors
}
