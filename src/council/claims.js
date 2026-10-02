// Daftar klaim bersama untuk satu sidang. Klaim yang sama dari panelis atau ronde berbeda digabung dan
// diberi ID tetap (K1, K2, …), jadi panelis cukup merujuk ID-nya tanpa menulis ulang teksnya.
// Ini menghemat token tanpa memotong isi, dan membuat hasil verifikasi melekat ke klaimnya.

import { VERIFY_STATUS, normalizeText, normalizeUrl } from '../evidence/verify.js'

export const CLAIM_ID = /^K\d+$/

function claimKey(claim) {
  const body = normalizeText(claim.quote || claim.text)
  return claim.source_url ? `${normalizeUrl(claim.source_url)}|${body}` : `|${normalizeText(claim.text)}`
}

export class ClaimRegistry {
  constructor() {
    this.claims = []
    this.byKey = new Map()
    this.byId = new Map()
  }

  add(claim, { agent, round }) {
    const key = claimKey(claim)
    let entry = this.byKey.get(key)
    if (!entry) {
      entry = {
        id: `K${this.claims.length + 1}`,
        text: claim.text,
        kind: claim.kind,
        source_url: claim.source_url,
        quote: claim.quote,
        by: [],
        rounds: [],
        verification: null
      }
      this.claims.push(entry)
      this.byKey.set(key, entry)
      this.byId.set(entry.id, entry)
    }
    if (!entry.by.includes(agent)) entry.by.push(agent)
    if (!entry.rounds.includes(round)) entry.rounds.push(round)
    return entry
  }

  has(id) {
    return this.byId.has(id)
  }

  get(id) {
    return this.byId.get(id)
  }

  list() {
    return this.claims
  }

  // Klaim yang belum diverifikasi: yang punya URL, atau klaim fakta tanpa URL.
  pending() {
    return this.claims.filter((c) => !c.verification && (c.source_url || c.kind === 'fact'))
  }

  setVerification(results) {
    for (const [id, v] of results) {
      const entry = this.byId.get(id)
      if (entry) entry.verification = v
    }
  }
}

export function statusIcon(claim) {
  return claim.verification ? VERIFY_STATUS[claim.verification.status]?.icon || '?' : '·'
}

// Satu baris per klaim, untuk prompt. Kutipan hanya disertakan untuk klaim ✅ (teks yang benar-benar ada
// di sumber), supaya agen tanpa web search mendapat "paket bukti" yang bisa dipercaya.
export function registryBlock(claims, aliasOf = (id) => id) {
  if (!claims.length) return ''
  const lines = ['Daftar klaim sidang (ID · status · jenis · teks · sumber · oleh):']
  for (const c of claims) {
    const parts = [`${c.id} ${statusIcon(c)} ${c.kind}: ${c.text}`]
    if (c.source_url) parts.push(c.source_url)
    if (c.verification?.status === 'verified' && c.quote) parts.push(`kutipan: "${c.quote}"`)
    else if (c.verification && c.verification.status !== 'no_source') parts.push(c.verification.detail)
    parts.push(`oleh ${c.by.map(aliasOf).join(', ')}`)
    lines.push(parts.join(' | '))
  }
  lines.push('Status: ✅ kutipan ditemukan · ⚠️ kutipan tidak cocok atau tidak ada · ❔ tidak bisa dicek otomatis · ❌ sumber tidak ada · ➖ tanpa sumber · · belum dicek')
  return lines.join('\n')
}

export function countByStatus(claims) {
  const counts = {}
  for (const c of claims) {
    const s = c.verification?.status
    if (s) counts[s] = (counts[s] || 0) + 1
  }
  return counts
}
