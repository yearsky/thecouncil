// Memori sidang: kesimpulan dan klaim ✅ dari sidang yang sudah selesai, untuk dilanjutkan di sidang baru.
// Isinya diambil persis dari hasil sidang (bukan ringkasan buatan AI), jadi tidak ada informasi yang hilang
// diam-diam. Memori hanya dipakai kalau pengguna memilihnya ("Lanjutkan dari…" / --lanjut).

import { clip } from './prompts.js'

const verifiedOnly = (claims = []) =>
  claims
    .filter((c) => c.verification?.status === 'verified')
    .map((c) => ({ text: c.text, kind: c.kind, source_url: c.source_url, quote: c.quote, verification: c.verification }))

// Insight riset yang bersumber: ID sumber diganti judul/URL-nya, karena nomor S dan K tidak berlaku di sidang baru.
// Hanya sumber literatur dan klaim ✅ yang dihitung sebagai sumber.
function sourcedInsights(insights = [], literature = [], claims = []) {
  const papers = new Map(literature.map((p) => [p.id, `${p.title}${p.year ? ` (${p.year})` : ''}`]))
  const verified = new Map(claims.filter((c) => c.verification?.status === 'verified').map((c) => [c.id, c.source_url || c.text]))
  return insights
    .map((x) => ({ finding: x.finding, sources: x.sources.map((ref) => papers.get(ref) || verified.get(ref)).filter(Boolean) }))
    .filter((x) => x.sources.length)
}

// Dari hasil runCouncil(). `id` = ID sidang (folder sesi di CLI, ID run di cloud).
export function memoryFromResult(result, { id }) {
  return {
    id,
    topic: result.topic,
    question: result.frame?.question || result.topic,
    status: result.status,
    finishedAt: result.finishedAt,
    summary: result.final?.summary || '',
    draft: result.final?.draft || '',
    claims: verifiedOnly(result.claims),
    insights: sourcedInsights(result.research?.insights, result.research?.literature, result.claims)
  }
}

// Dari daftar event (events.jsonl). Dipakai untuk sidang lama yang belum punya memory.json.
export function memoryFromEvents(events, { id }) {
  const started = events.find((e) => e.type === 'session_started')
  const framed = events.find((e) => e.type === 'framed')
  const finished = events.findLast((e) => e.type === 'finished')
  if (!finished) throw new Error(`sidang ${id} belum selesai, jadi belum punya kesimpulan`)
  const claims = new Map()
  const literature = events.find((e) => e.type === 'literature')?.papers || []
  const researched = events.find((e) => e.type === 'researched')
  for (const e of events) {
    if (e.type === 'agent_finished') for (const c of e.response?.claims || []) if (c.id && !claims.has(c.id)) claims.set(c.id, { ...c })
    if (e.type === 'researched') for (const c of e.claims || []) if (c.id && !claims.has(c.id)) claims.set(c.id, { ...c })
    if (e.type === 'verified') {
      for (const v of e.claims || []) {
        const c = claims.get(v.id)
        if (c) c.verification = { status: v.status, detail: v.detail, checkedAt: e.ts }
      }
    }
  }
  return {
    id,
    topic: started?.topic || '',
    question: framed?.question || started?.topic || '',
    status: finished.status,
    finishedAt: finished.ts,
    summary: finished.summary || '',
    draft: finished.draft || '',
    claims: verifiedOnly([...claims.values()]),
    insights: sourcedInsights(researched?.insights, literature, [...claims.values()])
  }
}

const STATUS_TEXT = { unanimous: 'disepakati bulat', majority: 'disepakati mayoritas', no_consensus: 'tidak ada konsensus', error: 'gagal' }

// Blok prompt. Ditaruh di bagian statis (sama untuk semua ronde sidang ini), supaya tetap bisa di-cache.
export function memoryBlock(memory = [], idsByMemory = {}) {
  if (!memory.length) return ''
  const lines = [
    'Memori sidang sebelumnya (dipilih pengguna untuk dilanjutkan). Ini konteks, bukan bukti baru: keputusan lama boleh dipertahankan atau diubah, tapi nilai ulang dengan bukti di sidang ini.'
  ]
  for (const m of memory) {
    lines.push(`### Sidang ${m.id}: ${m.question}`, `Hasil: ${STATUS_TEXT[m.status] || m.status}${m.finishedAt ? ` (${m.finishedAt.slice(0, 10)})` : ''}`)
    if (m.summary) lines.push(`Ringkasan: ${m.summary}`)
    if (m.draft) lines.push('Kesimpulan:', '<<<', clip(m.draft), '>>>')
    const ids = idsByMemory[m.id] || []
    if (ids.length) lines.push(`Klaim ✅ dari sidang ini ada di daftar klaim: ${ids.join(', ')}`)
    if (m.insights?.length) lines.push('Temuan riset sidang ini (dengan sumbernya):', ...m.insights.map((x) => `- ${x.finding} (sumber: ${x.sources.join('; ')})`))
  }
  return lines.join('\n')
}
