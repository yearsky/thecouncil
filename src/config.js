// Membaca council.config.json (opsional) dan .env.

import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_FILE = 'council.config.json'

export const DEFAULT_CONFIG = {
  language: 'id',
  // Claude memimpin sidang dan juga ikut debat; modelnya bisa beda untuk tiap peran.
  moderator: { agent: 'claude', model: 'sonnet' },
  panel: ['claude', 'codex', 'deepseek'],
  maxRounds: 3,
  consensus: 'unanimous',
  agents: {
    claude: { type: 'claude-cli', bin: 'claude', model: 'sonnet', timeoutMs: 300000, extraArgs: [] },
    codex: { type: 'codex-cli', bin: 'codex', model: '', timeoutMs: 300000, webSearchArgs: ['-c', 'web_search=live'], extraArgs: [] },
    deepseek: {
      type: 'openai-compatible',
      label: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      model: '',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      timeoutMs: 180000
    }
  }
}

export function mergeConfig(base, user = {}) {
  const agents = {}
  for (const id of new Set([...Object.keys(base.agents), ...Object.keys(user.agents || {})])) {
    agents[id] = { ...base.agents[id], ...user.agents?.[id] }
  }
  return { ...base, ...user, moderator: { ...base.moderator, ...user.moderator }, agents }
}

export function validateConfig(config) {
  const errors = []
  const known = (id) => Object.hasOwn(config.agents, id)
  if (!Array.isArray(config.panel) || config.panel.length === 0) errors.push('"panel" harus berisi minimal satu agen')
  for (const id of config.panel || []) if (!known(id)) errors.push(`agen panel "${id}" tidak ada di "agents"`)
  if (!known(config.moderator?.agent)) errors.push(`moderator "${config.moderator?.agent}" tidak ada di "agents"`)
  return errors
}

export function loadConfig({ cwd = process.cwd(), file } = {}) {
  const configPath = path.resolve(cwd, file || CONFIG_FILE)
  if (!fs.existsSync(configPath)) {
    if (file) throw new Error(`File config tidak ditemukan: ${configPath}`)
    return { ...DEFAULT_CONFIG, source: null }
  }
  let user
  try {
    // Notepad di Windows bisa menyimpan UTF-8 dengan BOM, yang membuat JSON.parse gagal.
    user = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, ''))
  } catch (err) {
    throw new Error(`Gagal membaca ${configPath}: ${err.message}`)
  }
  return { ...mergeConfig(DEFAULT_CONFIG, user), source: configPath }
}

export function loadEnv({ cwd = process.cwd() } = {}) {
  const envPath = path.join(cwd, '.env')
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath)
}
