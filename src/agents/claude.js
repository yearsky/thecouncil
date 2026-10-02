// Agen: Claude Code CLI (`claude -p`), memakai login langganan Claude di komputer ini (tanpa API key).
// Jangan pakai --bare: mode itu tidak membaca login langganan (docs/PLAN.md, F2).

import { cliVersion, runCli } from './cli.js'

export const WEB_TOOLS = 'WebSearch,WebFetch'

// Argumen dilewatkan cmd.exe di Windows: baris baru memutus perintah dan % ^ & " < > | punya arti khusus.
// Teks panjang (prompt, data debat) selalu lewat stdin; argumen hanya untuk teks pendek seperti system prompt.
export function safeArg(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/[%^&<>|]/g, '')
    .trim()
}

export function claudeArgs({ system, model, webSearch = false, extraArgs = [] } = {}) {
  // stream-json (wajib bersama --verbose di mode -p) dipakai agar event "init" terbaca:
  // model, tool, dan plugin yang benar-benar aktif.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk']
  if (system) args.push('--system-prompt', safeArg(system))
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  if (webSearch) args.push('--allowedTools', WEB_TOOLS)
  // --tools menerima banyak nilai, jadi taruh paling akhir. "" = nonaktifkan semua tool.
  args.push('--tools', webSearch ? WEB_TOOLS : '')
  return args
}

function readEvents(stdout) {
  const events = []
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // baris non-JSON (mis. peringatan) diabaikan
    }
  }
  return events
}

const resultError = (ev) => new Error(`Claude error: ${ev.result || ev.subtype || 'tidak diketahui'}`)

export function parseClaudeStream(stdout) {
  const events = readEvents(stdout)
  const init = events.find((ev) => ev.type === 'system' && ev.subtype === 'init')
  const result = events.findLast((ev) => ev.type === 'result')
  if (!result) throw new Error('Claude tidak mengirim hasil (event "result" tidak ada)')
  if (result.is_error) throw resultError(result)
  // Hitung pemakaian tool, mis. untuk memastikan WebSearch benar-benar dipanggil.
  const toolUses = {}
  for (const ev of events) {
    if (ev.type !== 'assistant' || ev.parent_tool_use_id) continue
    for (const block of ev.message?.content || []) {
      if (block.type === 'tool_use' || block.type === 'server_tool_use') toolUses[block.name] = (toolUses[block.name] || 0) + 1
    }
  }
  return {
    text: typeof result.result === 'string' ? result.result : '',
    costUsd: result.total_cost_usd,
    usage: result.usage,
    meta: {
      model: init?.model,
      tools: init?.tools,
      plugins: (init?.plugins || []).map((p) => p.name),
      mcpServers: (init?.mcp_servers || []).map((s) => s.name),
      toolUses
    }
  }
}

export function createClaudeAgent({ id = 'claude', label = 'Claude', bin = 'claude', model, timeoutMs = 300000, extraArgs = [], cwd } = {}) {
  return {
    id,
    label,
    type: 'claude-cli',
    bin,
    model,
    extraArgs,
    capabilities: { webSearch: true },
    version: () => cliVersion(bin),
    async ask({ system, prompt, webSearch = false, model: modelOverride, timeoutMs: t } = {}) {
      const args = claudeArgs({ system, model: modelOverride || model, webSearch, extraArgs })
      let stdout
      try {
        ;({ stdout } = await runCli(bin, args, { input: prompt, timeoutMs: t || timeoutMs, cwd }))
      } catch (err) {
        // Kegagalan di dalam run (mis. belum login) dicetak Claude sebagai event "result" di stdout.
        const failed = err.stdout && readEvents(err.stdout).findLast((ev) => ev.type === 'result' && ev.is_error)
        throw failed ? resultError(failed) : err
      }
      return parseClaudeStream(stdout)
    }
  }
}
