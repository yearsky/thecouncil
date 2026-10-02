// Token per panggilan dalam bentuk seragam, supaya penghematan bisa diukur, bukan ditebak.
// input = token input yang tidak berasal dari cache; cacheRead/cacheWrite = token yang dibaca/ditulis ke
// prompt cache penyedia; output = token jawaban.

export const EMPTY_TOKENS = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

export function fromAnthropicUsage(u) {
  if (!u) return null
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0
  }
}

// Format OpenAI. DeepSeek melaporkan cache sebagai prompt_cache_hit_tokens (belum diverifikasi ke docs
// resminya); OpenAI memakai prompt_tokens_details.cached_tokens.
export function fromOpenAiUsage(u) {
  if (!u) return null
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0
  return { input: Math.max(0, (u.prompt_tokens ?? 0) - cached), cacheRead: cached, cacheWrite: 0, output: u.completion_tokens ?? 0 }
}

export function addTokens(a, b) {
  if (!b) return a
  return { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output }
}

export const totalInput = (t) => t.input + t.cacheRead + t.cacheWrite
