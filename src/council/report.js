// Laporan Markdown dari hasil runCouncil(). Disusun oleh kode dari data terstruktur, bukan ditulis ulang oleh AI.

import { totalInput } from '../agents/usage.js'
import { VERIFY_STATUS } from '../evidence/verify.js'

export const STATUS_LABEL = {
  unanimous: '✔ BULAT',
  majority: '◐ MAYORITAS',
  no_consensus: '✖ TIDAK ADA KONSENSUS',
  error: '✖ GAGAL'
}

export const VOTE_LABEL = {
  AGREE: '✔ setuju',
  AGREE_WITH_RESERVATIONS: '◐ setuju dengan catatan',
  DISAGREE: '✖ tidak setuju'
}

export const FLAG_LABEL = {
  contradictory_vote: 'menyatakan setuju tapi tetap menulis keberatan pemblokir (dihitung tidak setuju)',
  unexplained_flip: 'suara berubah tanpa penjelasan',
  change_without_reason: 'berubah pendapat tanpa menyebut bukti atau alasan',
  unknown_citation: 'merujuk ID klaim yang tidak ada'
}

const STAGE_LABEL = { frame: 'Merumuskan pertanyaan', research: 'Riset (peneliti)', panel: 'Jawaban panelis', judge: 'Rangkuman moderator', vote: 'Suara akhir', repair: 'Perbaikan format JSON' }

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const secs = (ms) => `${(ms / 1000).toFixed(1)} dtk`
const num = (n) => Math.round(n).toLocaleString('id-ID')
const who = (p) => `${p.label}${p.model ? ` (${p.model})` : ''}`

function formatTime(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function roundTitle(r) {
  if (r.mode === 'blind') return `Ronde ${r.round} (blind)`
  if (r.mode === 'critique') return `Ronde ${r.round} (kritik)`
  return 'Pemungutan suara akhir'
}

// Draft moderator bisa memakai judul # atau ##; turunkan levelnya supaya tetap di bawah judul laporan.
export function demoteHeadings(markdown, levels = 2) {
  let inFence = false
  return String(markdown)
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      if (inFence) return line
      return line.replace(/^(#{1,6})(?=\s)/, (h) => '#'.repeat(Math.min(6, h.length + levels)))
    })
    .join('\n')
}

function verificationCell(c) {
  if (!c.verification) return '· belum dicek'
  const s = VERIFY_STATUS[c.verification.status]
  return `${s?.icon || '?'} ${c.verification.detail || s?.label || c.verification.status}`
}

export function buildReport(result) {
  const labelOf = Object.fromEntries(result.panel.map((p) => [p.id, p.label]))
  const nameWithAlias = (id) => `${labelOf[id] || id}${result.aliases?.[id] ? ` (${result.aliases[id]})` : ''}`
  const minutes = Math.max(1, Math.round((new Date(result.finishedAt) - new Date(result.startedAt)) / 60000))
  const debateRounds = result.rounds.filter((r) => r.mode !== 'vote').length
  const out = []
  out.push(`# The Council — ${result.frame.question}`, '')
  out.push('| | |', '|---|---|')
  out.push(`| Topik | ${cell(result.topic)} |`)
  out.push(`| Status | ${STATUS_LABEL[result.status] || result.status} |`)
  out.push(`| Panel | ${cell(result.panel.map((p) => `${who(p)}${p.alias ? ` = ${p.alias}` : ''}${result.lenses?.[p.id] ? ` (lensa: ${result.lenses[p.id]})` : ''}`).join(', '))} |`)
  out.push(`| Moderator | ${cell(who(result.moderator))} |`)
  out.push(`| Ronde debat | ${debateRounds} dari maks. ${result.maxRounds}${result.rounds.some((r) => r.mode === 'vote') ? ' + suara akhir' : ''} |`)
  out.push(`| Aturan konsensus | ${result.consensus === 'majority' ? 'mayoritas' : 'bulat'} |`)
  out.push(`| Web search | ${result.web ? 'aktif untuk agen yang mendukung' : 'mati'} |`)
  out.push(`| Verifikasi sumber | ${result.verify ? 'aktif (oleh program)' : 'mati'} |`)
  if (result.research) out.push(`| Riset literatur | ${result.research.literature.length} sumber ilmiah, ${result.research.insights.length} insight |`)
  if (result.memory?.length) {
    const list = result.memory.map((m) => `${m.id} (${m.question}; klaim ✅: ${m.claims.length ? m.claims.join(', ') : 'tidak ada'})`)
    out.push(`| Melanjutkan sidang | ${cell(list.join('\n'))} |`)
  }
  out.push(`| Waktu | ${formatTime(result.startedAt)}, sekitar ${minutes} menit |`, '')

  if (result.frame.criteria.length || result.frame.context) {
    out.push('## Kriteria keberhasilan', '')
    out.push(...result.frame.criteria.map((c) => `- ${c}`))
    if (result.frame.context) out.push('', `Konteks: ${result.frame.context}`)
    out.push('')
  }
  if (result.frame.obvious?.length) {
    out.push('## Jawaban klise yang harus dilampaui', '', '> Disusun moderator sebelum debat: jawaban yang paling mungkin diberikan kebanyakan orang atau AI.', '')
    out.push(...result.frame.obvious.map((o) => `- ${o}`), '')
  }

  out.push('## Kesimpulan', '')
  if (result.final?.draft) {
    out.push(demoteHeadings(result.final.draft), '')
    if (result.status !== 'unanimous') out.push(`> Kesimpulan ini **tidak disetujui bulat**. Lihat suara dan perbedaan pendapat di bawah.`, '')
  } else out.push('_Sidang tidak menghasilkan kesimpulan._', '')

  if (result.decided) {
    out.push(`## Suara atas draft ronde ${result.decided.draftRound}`, '')
    out.push('| Panelis | Suara | Catatan |', '|---|---|---|')
    for (const p of result.panel) {
      const v = result.decided.votes[p.id]
      if (!v) {
        out.push(`| ${cell(nameWithAlias(p.id))} | – gagal menjawab | |`)
        continue
      }
      const notes = [...v.blocking_objections.map((o) => `**Keberatan:** ${o}`), ...v.reservations.map((r) => `Catatan: ${r}`)]
      if (v.change_reason) notes.push(`Alasan berubah: ${v.change_reason}`)
      out.push(`| ${cell(nameWithAlias(p.id))} | ${VOTE_LABEL[v.on_draft]} | ${cell(notes.join('\n'))} |`)
    }
    out.push('')
  }

  if (result.final?.agreements?.length) out.push('## Poin yang disepakati', '', ...result.final.agreements.map((a) => `- ${a}`), '')
  if (result.final?.disagreements?.length) out.push('## Perbedaan pendapat', '', ...result.final.disagreements.map((d) => `- ${d}`), '')

  if (result.research) out.push(...researchSection(result.research))

  if (result.flags?.length) {
    out.push('## Catatan integritas', '')
    out.push('> Dicatat oleh program. Tidak mengubah hasil suara, kecuali "setuju tapi menulis keberatan pemblokir" yang dihitung tidak setuju.', '')
    for (const f of result.flags) {
      out.push(`- Ronde ${f.round}: ${nameWithAlias(f.agent)} ${FLAG_LABEL[f.type] || f.type}${f.detail ? ` (${f.detail})` : ''}`)
    }
    out.push('')
  }

  const claims = result.claims || []
  if (claims.length) {
    out.push('## Klaim dan sumber', '')
    if (result.verify) {
      const counts = {}
      for (const c of claims) if (c.verification) counts[c.verification.status] = (counts[c.verification.status] || 0) + 1
      const summary = Object.entries(counts).map(([s, n]) => `${VERIFY_STATUS[s]?.icon || s} ${n}`).join(' · ')
      out.push(`> Diperiksa oleh program: halaman sumber dibuka dan kutipannya dicari. ${summary || 'Belum ada yang diperiksa.'}`)
      out.push('> ❔ berarti tidak bisa dicek otomatis (mis. situs memblokir bot atau berupa PDF), bukan berarti salah.')
      if (result.research?.literature.length) out.push('> Kutipan dari sumber literatur S dicek ke judul dan abstraknya.')
      out.push('')
    } else out.push('> Verifikasi sumber dimatikan; klaim di bawah belum diperiksa.', '')
    out.push('| ID | Klaim | Jenis | Sumber | Verifikasi | Oleh |', '|---|---|---|---|---|---|')
    for (const c of claims) {
      const source = c.source_url ? `${c.source_url}${c.quote ? `<br>"${c.quote}"` : ''}` : '–'
      const by = c.by.map((id) => (id === 'memori' ? 'memori sidang sebelumnya' : id === 'peneliti' ? 'peneliti' : labelOf[id] || id)).join(', ')
      const rounds = c.rounds.filter((r) => r > 0)
      out.push(`| ${c.id} | ${cell(c.text)} | ${c.kind} | ${cell(source)} | ${cell(verificationCell(c))} | ${cell(rounds.length ? `${by}; ronde ${rounds.join(', ')}` : by)} |`)
    }
    out.push('')
  }

  out.push('## Jalannya sidang', '')
  for (const r of result.rounds) {
    out.push(`### ${roundTitle(r)}`, '')
    if (r.devilsAdvocate) out.push(`Devil's advocate: ${nameWithAlias(r.devilsAdvocate)}`, '')
    for (const p of result.panel) {
      const res = r.results[p.id]
      if (!res) continue
      if (!res.ok) {
        out.push(`#### ${nameWithAlias(p.id)} — gagal (${secs(res.ms)})`, '', `\`${res.error}\``, '')
        continue
      }
      const x = res.response
      out.push(`#### ${nameWithAlias(p.id)} · ${secs(res.ms)}${res.repaired ? ' · format diperbaiki' : ''}`, '')
      if (x.position) out.push(x.position, '')
      if (x.proposals?.length) {
        for (const pr of x.proposals) {
          out.push(`- **${pr.id}: ${pr.title}**${pr.why ? ` — ${pr.why}` : ''}${pr.basis?.length ? ` _(dasar: ${pr.basis.join(', ')})_` : ''}`)
          if (pr.non_obvious) out.push(`  - Tidak umum karena: ${pr.non_obvious}`)
          if (pr.why_now) out.push(`  - Kenapa sekarang: ${pr.why_now}`)
        }
        out.push('')
      }
      const ids = [...new Set([...(x.claims || []).map((c) => c.id), ...(x.cited_claims || [])])]
      if (ids.length) out.push(`Klaim: ${ids.join(', ')}`, '')
      if (x.critiques?.length) out.push('Kritik:', ...x.critiques.map((c) => `- [${c.severity}]${c.target ? ` ${c.target}:` : ''} ${c.point}`), '')
      if (x.changed_mind?.changed) out.push(`Berubah pendapat: ${x.changed_mind.what} (karena: ${x.changed_mind.because || 'tidak disebutkan'})`, '')
      if (x.vote) {
        out.push(`Suara: ${VOTE_LABEL[x.vote.on_draft]}`)
        for (const o of x.vote.blocking_objections) out.push(`- Keberatan: ${o}`)
        for (const n of x.vote.reservations) out.push(`- Catatan: ${n}`)
        if (x.vote.change_reason) out.push(`- Alasan berubah: ${x.vote.change_reason}`)
        out.push('')
      }
    }
    if (r.tally) out.push(`Hasil suara: ${r.tally.accepted.length} dari ${r.tally.total} setuju (${STATUS_LABEL[r.tally.status]}).`, '')
    if (r.judged) {
      out.push(`**Moderator:** ${r.judged.summary}`, '')
      if (r.judged.next_focus && r !== result.rounds.at(-1)) out.push(`Fokus berikutnya: ${r.judged.next_focus}`, '')
      out.push('<details><summary>Draft moderator</summary>', '', demoteHeadings(r.judged.draft, 3), '', '</details>', '')
    }
  }

  out.push(...usageSection(result, labelOf))
  return out.join('\n')
}

function researchSection(research) {
  const out = ['## Riset', '']
  if (research.insights.length) {
    out.push('### Insight', '', '> Ditulis peneliti AI sebelum debat. Insight adalah tafsiran; buktinya sumber S dan klaim K yang dirujuk.', '')
    for (const x of research.insights) {
      out.push(`- **${x.id}: ${x.finding}**${x.sources.length ? ` (${x.sources.join(', ')})` : ' (tanpa sumber)'}`)
      if (x.why_non_obvious) out.push(`  - Tidak umum karena: ${x.why_non_obvious}`)
      if (x.implication) out.push(`  - Implikasi: ${x.implication}`)
      if (x.open_question) out.push(`  - Belum pasti: ${x.open_question}`)
    }
    out.push('')
  }
  if (research.gaps?.length) out.push('### Masalah yang belum terpecahkan', '', ...research.gaps.map((g) => `- ${g}`), '')
  if (research.why_now?.length) out.push('### Yang baru berubah (why now)', '', ...research.why_now.map((w) => `- ${w}`), '')
  if (research.literature.length) {
    out.push('### Sumber literatur', '', '> Judul dan abstrak diambil program dari indeks ilmiah (Semantic Scholar, OpenAlex, arXiv).', '')
    out.push('| ID | Judul | Tahun | Venue | Sitasi | Tautan |', '|---|---|---|---|---|---|')
    for (const p of research.literature) out.push(`| ${p.id} | ${cell(p.title)} | ${p.year || '–'} | ${cell(p.venue || '–')} | ${p.citations ?? '–'} | ${p.url || '–'} |`)
    out.push('')
  }
  return out
}

function usageSection(result, labelOf) {
  const u = result.usage
  const out = ['## Pemakaian', '']
  out.push(`- Panggilan AI: ${u.calls}${u.failedCalls ? ` (${u.failedCalls} gagal)` : ''}; total durasi panggilan ${Math.round(u.ms / 1000)} dtk (sebagian berjalan paralel)`)
  if (u.searches) out.push(`- Pencarian web yang dilaporkan penyedia: ${u.searches}`)
  if (u.costUsd) out.push(`- Estimasi biaya: $${u.costUsd.toFixed(4)} (Claude Code: \`total_cost_usd\`; agen API: dari "pricing" di config). Ini estimasi sisi klien, bukan tagihan.`)
  if (u.truncated) out.push(`- ⚠️ ${u.truncated} jawaban berhenti di batas \`maxTokens\` dan mungkin terpotong. Naikkan \`maxTokens\` agen di config.`)
  if (u.measured) {
    out.push(`- Token terukur untuk ${u.measured} dari ${u.calls} panggilan (Codex CLI belum melaporkan token).`, '')
    const row = (name, b) =>
      `| ${cell(name)} | ${b.calls} | ${num(totalInput(b.tokens))} | ${num(b.tokens.cacheRead)} | ${num(b.tokens.output)} | ${b.costUsd ? `$${b.costUsd.toFixed(4)}` : '–'} |`
    out.push('| Peran | Panggilan | Token input | dari cache | Token output | Estimasi biaya |', '|---|---|---|---|---|---|')
    for (const [role, b] of Object.entries(u.byRole)) out.push(row(role === 'moderator' ? `Moderator (${result.moderator.label})` : `${labelOf[role] || role} (panelis)`, b))
    out.push('')
    out.push('| Tahap | Panggilan | Token input | dari cache | Token output | Estimasi biaya |', '|---|---|---|---|---|---|')
    for (const [stage, b] of Object.entries(u.byStage)) out.push(row(STAGE_LABEL[stage] || stage, b))
  }
  out.push('')
  return out
}
