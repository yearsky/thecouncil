// Agen: OpenAI Codex CLI (`codex exec`), memakai login akun ChatGPT di komputer ini (tanpa API key).
// Pola dari yearsky/chatbot-wa (src/ai/codexCli.js).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliVersion, runCli } from './cli.js'

// Cara menyalakan web search di `codex exec` belum dipastikan (docs/PLAN.md, F5), jadi bisa diganti
// lewat config, mis. ["--search"]. Nilai tanpa tanda kutip: Codex membaca nilai -c sebagai TOML,
// dan jika gagal dipakai sebagai string biasa, jadi `live` aman dari quoting cmd.exe.
export const DEFAULT_WEB_SEARCH_ARGS = ['-c', 'web_search=live']

export function codexArgs({ outFile, model, webSearch = false, webSearchArgs = DEFAULT_WEB_SEARCH_ARGS, extraArgs = [] }) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--color', 'never',
    '--output-last-message', outFile
  ]
  if (model) args.push('--model', model)
  if (webSearch) args.push(...webSearchArgs)
  args.push(...extraArgs)
  args.push('-') // baca prompt dari stdin
  return args
}

export function createCodexAgent({
  id = 'codex',
  label = 'Codex',
  bin = 'codex',
  model,
  timeoutMs = 300000,
  webSearchArgs = DEFAULT_WEB_SEARCH_ARGS,
  extraArgs = [],
  cwd
} = {}) {
  return {
    id,
    label,
    type: 'codex-cli',
    bin,
    model,
    extraArgs,
    capabilities: { webSearch: true },
    version: () => cliVersion(bin),
    async ask({ system, prompt, webSearch = false, model: modelOverride, timeoutMs: t } = {}) {
      const outFile = path.join(os.tmpdir(), `thecouncil-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      const args = codexArgs({ outFile, model: modelOverride || model, webSearch, webSearchArgs, extraArgs })
      // `codex exec` tidak punya flag system prompt, jadi instruksi peran ditaruh di awal prompt.
      const input = system ? `${system}\n\n${prompt}` : prompt
      try {
        const { stdout } = await runCli(bin, args, { input, timeoutMs: t || timeoutMs, cwd })
        const last = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : ''
        return { text: last || stdout.trim(), meta: { model: modelOverride || model || null } }
      } finally {
        fs.rmSync(outFile, { force: true })
      }
    }
  }
}
