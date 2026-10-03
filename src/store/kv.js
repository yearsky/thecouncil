// Penyimpanan key-value untuk mode server (Vercel). Dua implementasi dengan antarmuka yang sama:
// - memoryKv(): di memori proses, untuk test dan `council ui` lokal.
// - upstashKv(): Upstash Redis lewat REST API (perintah Redis sebagai array JSON), tanpa SDK.
// Semua nilai berupa string; pemanggil yang mengubah ke/dari JSON.

export function memoryKv({ now = Date.now } = {}) {
  const data = new Map()
  const expiry = new Map()
  const live = (key) => {
    const at = expiry.get(key)
    if (at !== undefined && at <= now()) {
      data.delete(key)
      expiry.delete(key)
    }
    return data.has(key)
  }
  const list = (key) => (live(key) ? data.get(key) : [])
  const hash = (key) => (live(key) ? data.get(key) : new Map())
  // Indeks seperti Redis: negatif dihitung dari belakang, stop inklusif.
  const range = (arr, start, stop) => {
    const n = arr.length
    const s = start < 0 ? Math.max(0, n + start) : start
    const e = stop < 0 ? n + stop : Math.min(stop, n - 1)
    return e < s ? [] : arr.slice(s, e + 1)
  }
  return {
    kind: 'memory',
    async get(key) {
      return live(key) ? data.get(key) : null
    },
    async set(key, value, { nx = false, ex } = {}) {
      if (nx && live(key)) return false
      data.set(key, String(value))
      if (ex) expiry.set(key, now() + ex * 1000)
      else expiry.delete(key)
      return true
    },
    async del(key) {
      const had = live(key)
      data.delete(key)
      expiry.delete(key)
      return had ? 1 : 0
    },
    async exists(key) {
      return live(key)
    },
    async expire(key, seconds) {
      if (live(key)) expiry.set(key, now() + seconds * 1000)
    },
    async incr(key) {
      const n = Number((live(key) && data.get(key)) || 0) + 1
      data.set(key, String(n))
      return n
    },
    async rpush(key, ...values) {
      const arr = list(key)
      arr.push(...values.map(String))
      data.set(key, arr)
      return arr.length
    },
    async lpush(key, ...values) {
      const arr = list(key)
      arr.unshift(...values.map(String).reverse())
      data.set(key, arr)
      return arr.length
    },
    async lrange(key, start, stop) {
      return range(list(key), start, stop)
    },
    async llen(key) {
      return list(key).length
    },
    async hget(key, field) {
      return hash(key).get(field) ?? null
    },
    async hset(key, field, value) {
      const h = hash(key)
      h.set(field, String(value))
      data.set(key, h)
    }
  }
}

// Env dari integrasi Upstash di Vercel Marketplace. Namanya belum dicek ke docs, jadi keduanya dibaca.
export function upstashEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : null
}

export function upstashKv({ url, token, timeoutMs = 10000 }) {
  const base = String(url).replace(/\/+$/, '')
  async function cmd(...args) {
    let res
    try {
      res = await fetch(base, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      throw new Error(`Redis tidak bisa dihubungi: ${err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message}`)
    }
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.error) throw new Error(`Redis ${args[0]} gagal (HTTP ${res.status}): ${data?.error || 'jawaban tidak dikenal'}`)
    return data.result
  }
  return {
    kind: 'upstash',
    cmd,
    get: (key) => cmd('GET', key),
    async set(key, value, { nx = false, ex } = {}) {
      const args = ['SET', key, value]
      if (nx) args.push('NX')
      if (ex) args.push('EX', ex)
      return (await cmd(...args)) === 'OK'
    },
    del: (key) => cmd('DEL', key),
    exists: async (key) => (await cmd('EXISTS', key)) === 1,
    expire: (key, seconds) => cmd('EXPIRE', key, seconds),
    incr: (key) => cmd('INCR', key),
    rpush: (key, ...values) => cmd('RPUSH', key, ...values),
    lpush: (key, ...values) => cmd('LPUSH', key, ...values),
    lrange: (key, start, stop) => cmd('LRANGE', key, start, stop),
    llen: (key) => cmd('LLEN', key),
    hget: (key, field) => cmd('HGET', key, field),
    hset: (key, field, value) => cmd('HSET', key, field, value)
  }
}
