// Jurnal panggilan AI untuk sidang yang dicicil (mode server, docs/PLAN.md §18).
//
// Fungsi Vercel dibatasi durasinya, jadi satu sidang dijalankan dalam beberapa "slice". Setiap slice memutar
// ulang runCouncil() dari awal. Panggilan yang sudah pernah selesai (sukses maupun gagal) diambil dari jurnal
// tanpa memanggil API lagi; yang belum, dipanggil sungguhan lalu dicatat. Kalau waktu slice hampir habis,
// panggilan baru tidak dimulai: dilempar sinyal jeda (isYield) dan sidang lanjut di slice berikutnya.
//
// Supaya pemutaran ulang menghasilkan sidang yang persis sama, setiap hasil (dari jurnal maupun panggilan
// sungguhan) diserahkan ke sidang menurut nomor `seq`, yaitu urutan selesainya di slice aslinya. Urutan ini
// menentukan ID klaim (K1, K2, …), yang ikut masuk ke prompt tahap berikutnya.

import crypto from 'node:crypto'

export function yieldSignal(reason = 'waktu slice habis', extra = {}) {
  const err = new Error(`sidang dijeda: ${reason}`)
  err.isYield = true
  Object.assign(err, extra)
  return err
}

export const hashKey = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)

// Batas waktu slice: panggilan baru hanya boleh dimulai sebelum `startAllowedUntil`.
// `isCancelled` (opsional, async) dicek sebelum setiap panggilan baru.
export function createGate({ startAllowedUntil = Infinity, now = Date.now, isCancelled = async () => false } = {}) {
  return {
    async check() {
      if (await isCancelled()) throw yieldSignal('dibatalkan pengguna', { cancelled: true })
      if (now() > startAllowedUntil) throw yieldSignal()
    }
  }
}

// Penyimpanan jurnal di KV: hash `run:{id}:journal`, field = kunci panggilan, nilai = JSON.
export function kvJournal(kv, runId) {
  const key = `run:${runId}:journal`
  return {
    async get(field) {
      const raw = await kv.hget(key, field)
      return raw ? JSON.parse(raw) : null
    },
    async put(field, entry) {
      await kv.hset(key, field, JSON.stringify(entry))
    }
  }
}

// Mengembalikan hasil jurnal sesuai urutan `seq`. Hasil ditahan sampai semua pencarian jurnal yang sedang
// berjalan bersamaan selesai, lalu dilepas dari seq terkecil. Pelepasan ditunda ke setImmediate supaya semua
// promise sudah terpasang dengan kedalaman microtask yang sama; kalau tidak, hasil terakhir bisa menyalip.
function createSequencer() {
  let pending = 0
  let scheduled = false
  const ready = []
  function release() {
    scheduled = false
    if (pending > 0) return
    ready.sort((a, b) => a.seq - b.seq)
    for (const item of ready.splice(0)) item.release()
  }
  function flush() {
    if (pending > 0 || scheduled) return
    scheduled = true
    setImmediate(release)
  }
  return {
    async lookup(fn) {
      pending++
      let entry
      try {
        entry = await fn()
      } catch (err) {
        pending--
        flush()
        throw err
      }
      pending--
      if (!entry) {
        flush()
        return null
      }
      return this.enqueue(entry.seq, entry)
    },
    // Hasil panggilan sungguhan juga lewat sini: kalau masih ada hasil jurnal (seq lebih kecil) yang belum
    // dilepas, hasil baru harus menunggu, supaya urutan di slice ini sama dengan urutan saat diputar ulang.
    enqueue(seq, value) {
      return new Promise((release) => {
        ready.push({ seq, release: () => release(value) })
        flush()
      })
    }
  }
}

// Membungkus agen dan verifier dengan jurnal. `inflight` berisi panggilan sungguhan dan penulisan jurnal yang
// sedang berjalan, supaya runner bisa menunggunya selesai sebelum slice berakhir.
// `seqBase` harus lebih besar dari semua seq slice sebelumnya (runner memakai nomor slice × 1.000.000).
// Seq diberikan saat panggilan selesai, sebelum ada await, dan hasilnya langsung dikembalikan (jurnal ditulis di
// belakang), jadi urutan seq = urutan hasil diterima sidang di slice ini.
export function createReplay({ journal, gate, seqBase = 0 }) {
  const sequencer = createSequencer()
  const inflight = new Set()
  const writeErrors = []
  const seen = new Map()
  let counter = 0

  function track(promise) {
    inflight.add(promise)
    promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise)
    )
    return promise
  }

  function record(key, entry) {
    track(journal.put(key, entry).catch((err) => writeErrors.push(err.message)))
  }

  function nextKey(base) {
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    return `${base}#${n}`
  }

  async function run(key, live, { restore = (v) => v } = {}) {
    const hit = await sequencer.lookup(() => journal.get(key))
    if (hit) {
      if (hit.ok) return restore(hit.value, hit)
      const err = new Error(hit.error)
      err.elapsedMs = hit.elapsedMs
      throw err
    }
    await gate.check()
    const start = Date.now()
    return track(
      (async () => {
        let value
        try {
          value = await live()
        } catch (err) {
          if (err.isYield) throw err
          const elapsedMs = Date.now() - start
          const seq = seqBase + ++counter
          record(key, { ok: false, error: err.message, elapsedMs, seq })
          await sequencer.enqueue(seq)
          err.elapsedMs = elapsedMs
          throw err
        }
        const elapsedMs = Date.now() - start
        const seq = seqBase + ++counter
        record(key, { ok: true, value, elapsedMs, seq })
        await sequencer.enqueue(seq)
        return restore(value, { elapsedMs })
      })()
    )
  }

  return {
    agent(agent) {
      return {
        ...agent,
        ask(req = {}) {
          const base = hashKey({
            agent: agent.id,
            model: req.model || agent.model || null,
            system: req.system || null,
            prompt: req.prompt,
            webSearch: Boolean(req.webSearch),
            effort: req.effort || null
          })
          return run(nextKey(`ask:${base}`), () => agent.ask(req), { restore: (value, meta) => ({ ...value, elapsedMs: meta.elapsedMs }) })
        }
      }
    },
    verifier(verify) {
      if (!verify) return null
      return (pending) => {
        const base = hashKey(pending.map((c) => [c.id, c.text, c.source_url || '', c.quote || '']))
        return run(nextKey(`verify:${base}`), async () => [...(await verify(pending))], { restore: (entries) => new Map(entries) })
      }
    },
    // Tunggu panggilan dan penulisan jurnal selesai. Error penulisan dikembalikan supaya runner bisa
    // menghentikan sidang: tanpa jurnal, slice berikutnya bisa mendapat jawaban yang berbeda.
    async settle() {
      while (inflight.size) await Promise.allSettled([...inflight])
      return writeErrors
    }
  }
}
