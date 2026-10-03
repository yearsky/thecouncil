// Agen: API yang kompatibel dengan format Anthropic Messages, lewat fetch bawaan Node.
// Dipakai untuk DeepSeek (https://api.deepseek.com/anthropic) karena endpoint ini punya web search di sisi
// server (tool "web_search_20250305"), sedangkan endpoint format OpenAI tidak bisa browsing sendiri.
// Sumber: docs DeepSeek "Using the Anthropic API" (dikutip di anomalyco/opencode#32273). Belum diuji
// dengan API asli; `council doctor` yang memastikannya. Lihat docs/PLAN.md §18.

import { createOpenAiCompatAgent } from './openaiCompat.js'
import { addTokens, EMPTY_TOKENS, fromAnthropicUsage } from './usage.js'

export const SEARCH_TOOL = 'web_search_20250305'
const ANTHROPIC_VERSION = '2023-06-01'

// Harga per 1 juta token dari config (opsional). Tanpa harga, biaya tidak dihitung.
export function costFromPricing(tokens, pricing) {
  if (!pricing || !tokens) return undefined
  const p = (k, fallback = 0) => (typeof pricing[k] === 'number' ? pricing[k] : fallback)
  return (tokens.input * p('input') + tokens.cacheRead * p('cacheRead', p('input')) + tokens.cacheWrite * p('cacheWrite', p('input')) + tokens.output * p('output')) / 1e6
}

// Membaca isi jawaban: teks, pemakaian tool di sisi server, dan URL hasil pencarian.
export function readContent(content = []) {
  let text = ''
  const toolUses = {}
  const searchUrls = []
  const searchErrors = []
  for (const block of content) {
    if (block.type === 'text') text += block.text || ''
    else if (block.type === 'server_tool_use' || block.type === 'tool_use') toolUses[block.name] = (toolUses[block.name] || 0) + 1
    else if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        for (const r of block.content) if (r?.url && !searchUrls.includes(r.url)) searchUrls.push(r.url)
      } else if (block.content?.error_code) searchErrors.push(block.content.error_code)
    }
  }
  return { text, toolUses, searchUrls, searchErrors }
}

export function createAnthropicCompatAgent({
  id = 'deepseek',
  label = 'DeepSeek',
  baseURL = 'https://api.deepseek.com/anthropic',
  modelsURL = 'https://api.deepseek.com',
  model,
  apiKeyEnv = 'DEEPSEEK_API_KEY',
  timeoutMs = 180000,
  maxTokens = 32000,
  maxSearchUses = 5,
  maxContinuations = 3,
  pricing = null,
  extraBody = {}
} = {}) {
  const base = String(baseURL).replace(/\/+$/, '')
  const apiKey = () => process.env[apiKeyEnv] || ''
  const lister = createOpenAiCompatAgent({ id, label, baseURL: modelsURL, apiKeyEnv, timeoutMs })

  // Satu batas waktu untuk seluruh `ask` (termasuk lanjutan pause_turn dan fallback tanpa web search),
  // supaya satu panggilan tidak pernah lebih lama dari timeout-nya. Ini penting di Vercel: runner hanya
  // menyisakan waktu untuk satu panggilan penuh (src/cloud/app.js).
  const timeoutError = (t) => new Error(`${label} tidak merespons dalam ${Math.round(t / 1000)} detik`)

  async function post(body, { deadline, t }) {
    if (!apiKey()) throw new Error(`${apiKeyEnv} belum diisi di .env`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timeoutError(t)
    let res
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        // Docs Claude Code DeepSeek memakai ANTHROPIC_AUTH_TOKEN (Bearer); SDK Anthropic memakai x-api-key.
        headers: {
          'x-api-key': apiKey(),
          Authorization: `Bearer ${apiKey()}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining)
      })
    } catch (err) {
      if (err.name === 'TimeoutError') throw timeoutError(t)
      throw new Error(`${label} tidak bisa dihubungi (${base}): ${err.cause?.code || err.message}`)
    }
    let text
    try {
      text = await res.text()
    } catch (err) {
      if (err.name === 'TimeoutError') throw timeoutError(t)
      throw err
    }
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      // bukan JSON; pesan error memakai teks mentah
    }
    if (!res.ok) {
      const err = new Error(`${label} HTTP ${res.status}: ${data?.error?.message || text.slice(0, 200)}`)
      err.status = res.status
      throw err
    }
    return data
  }

  async function converse({ system, prompt, model: useModel, tools, limit }) {
    const messages = [{ role: 'user', content: prompt }]
    let tokens = { ...EMPTY_TOKENS }
    let webSearchRequests = 0
    const content = []
    let data
    // "pause_turn": giliran server dijeda (mis. pencarian panjang); kirim balik apa adanya untuk dilanjutkan.
    for (let i = 0; i <= maxContinuations; i++) {
      data = await post({ ...extraBody, model: useModel, max_tokens: maxTokens, ...(system ? { system } : {}), messages, ...(tools ? { tools } : {}) }, limit)
      tokens = addTokens(tokens, fromAnthropicUsage(data?.usage))
      webSearchRequests += data?.usage?.server_tool_use?.web_search_requests ?? 0
      content.push(...(data?.content || []))
      if (data?.stop_reason !== 'pause_turn') break
      messages.push({ role: 'assistant', content: data.content })
    }
    return { data, tokens, webSearchRequests, content }
  }

  return {
    id,
    label,
    type: 'anthropic-compatible',
    model,
    capabilities: { webSearch: true },
    apiKeyEnv,
    hasKey: () => Boolean(apiKey()),
    listModels: () => lister.listModels(),
    async ask({ system, prompt, model: modelOverride, webSearch = false, timeoutMs: t = timeoutMs } = {}) {
      const useModel = modelOverride || model
      if (!useModel) throw new Error(`Model ${label} belum diisi di config`)
      const tools = webSearch ? [{ type: SEARCH_TOOL, name: 'web_search', ...(maxSearchUses ? { max_uses: maxSearchUses } : {}) }] : null
      const limit = { deadline: Date.now() + t, t }
      let result
      let searchFallback = null
      try {
        result = await converse({ system, prompt, model: useModel, tools, limit })
      } catch (err) {
        // Kalau endpoint menolak tool web search (4xx), coba sekali tanpa tool dan catat alasannya.
        if (!tools || !(err.status >= 400 && err.status < 500) || err.status === 401 || err.status === 402 || err.status === 429) throw err
        searchFallback = err.message
        result = await converse({ system, prompt, model: useModel, tools: null, limit })
      }
      const read = readContent(result.content)
      const stopReason = result.data?.stop_reason || null
      return {
        text: read.text,
        usage: result.data?.usage,
        tokens: result.tokens,
        costUsd: costFromPricing(result.tokens, pricing),
        meta: {
          model: result.data?.model || useModel,
          stopReason,
          toolUses: read.toolUses,
          webSearchRequests: result.webSearchRequests,
          searchUrls: read.searchUrls,
          ...(read.searchErrors.length ? { searchErrors: read.searchErrors } : {}),
          ...(searchFallback ? { searchFallback } : {})
        }
      }
    }
  }
}
