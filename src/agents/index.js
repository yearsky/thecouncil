// Membuat agen berdasarkan council.config.json.

import os from 'node:os'
import path from 'node:path'
import { createClaudeAgent } from './claude.js'
import { createCodexAgent } from './codex.js'
import { createOpenAiCompatAgent } from './openaiCompat.js'

// Folder kosong sebagai working directory CLI, supaya CLAUDE.md, .mcp.json, atau file proyek
// di folder tempat `council` dijalankan tidak ikut terbaca oleh agen.
export const SANDBOX_DIR = path.join(os.tmpdir(), 'thecouncil', 'sandbox')

export function createAgent(id, cfg, { cwd = SANDBOX_DIR } = {}) {
  const common = { id, ...cfg }
  switch (cfg?.type) {
    case 'claude-cli':
      return createClaudeAgent({ label: 'Claude', ...common, cwd })
    case 'codex-cli':
      return createCodexAgent({ label: 'Codex', ...common, cwd })
    case 'openai-compatible':
      return createOpenAiCompatAgent({ label: id, ...common })
    default:
      throw new Error(`Tipe agen "${cfg?.type}" tidak dikenal (agen "${id}")`)
  }
}

// Agen yang dipakai sidang: panelis + moderator, tanpa duplikat, moderator lebih dulu.
export function agentIdsInUse(config) {
  return [...new Set([config.moderator.agent, ...config.panel])]
}
