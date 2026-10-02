// Agen: API yang kompatibel dengan format OpenAI (dipakai untuk DeepSeek), lewat fetch bawaan Node.
// Bayar per token dengan API key dari .env.

import { fromOpenAiUsage } from './usage.js'

export function createOpenAiCompatAgent({
  id = 'deepseek',
  label = 'DeepSeek',
  baseURL = 'https://api.deepseek.com',
  model,
  apiKeyEnv = 'DEEPSEEK_API_KEY',
  timeoutMs = 180000
} = {}) {
  const base = String(baseURL).replace(/\/+$/, '')
  const apiKey = () => process.env[apiKeyEnv] || ''

  async function request(pathname, { method = 'GET', body, timeoutMs: t = timeoutMs } = {}) {
    if (!apiKey()) throw new Error(`${apiKeyEnv} belum diisi di .env`)
    let res
    try {
      res = await fetch(base + pathname, {
        method,
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(t)
      })
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error(`${label} tidak merespons dalam ${Math.round(t / 1000)} detik`)
      throw new Error(`${label} tidak bisa dihubungi (${base}): ${err.cause?.code || err.message}`)
    }
    const text = await res.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      // bukan JSON; pesan error memakai teks mentah
    }
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${data?.error?.message || text.slice(0, 200)}`)
    return data
  }

  return {
    id,
    label,
    type: 'openai-compatible',
    model,
    capabilities: { webSearch: false },
    apiKeyEnv,
    hasKey: () => Boolean(apiKey()),
    async listModels() {
      const data = await request('/models')
      return (data?.data || []).map((m) => m.id)
    },
    async ask({ system, prompt, model: modelOverride, timeoutMs: t } = {}) {
      const useModel = modelOverride || model
      if (!useModel) throw new Error(`Model ${label} belum diisi di council.config.json`)
      const messages = system ? [{ role: 'system', content: system }] : []
      messages.push({ role: 'user', content: prompt })
      const data = await request('/chat/completions', {
        method: 'POST',
        body: { model: useModel, messages, stream: false },
        timeoutMs: t
      })
      return {
        text: data?.choices?.[0]?.message?.content ?? '',
        usage: data?.usage,
        tokens: fromOpenAiUsage(data?.usage),
        meta: { model: data?.model || useModel }
      }
    }
  }
}
