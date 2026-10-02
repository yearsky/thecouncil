// Laporan Markdown dari hasil runCouncil(). Disusun oleh kode dari data terstruktur, bukan ditulis ulang oleh AI.

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

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const secs = (ms) => `${(ms / 1000).toFixed(1)} dtk`
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

export function collectClaims(result) {
  const labelOf = Object.fromEntries(result.panel.map((p) => [p.id, p.label]))
  const seen = new Map()
  for (const r of result.rounds) {
    for (const [id, res] of Object.entries(r.results)) {
      for (const c of res.response?.claims || []) {
        const key = `${c.text.toLowerCase()}|${c.source_url}`
        if (!seen.has(key)) seen.set(key, { ...c, by: labelOf[id], round: r.round })
      }
    }
  }
  return [...seen.values()]
}

export function buildReport(result) {
  const minutes = Math.max(1, Math.round((new Date(result.finishedAt) - new Date(result.startedAt)) / 60000))
  const debateRounds = result.rounds.filter((r) => r.mode !== 'vote').length
  const out = []
  out.push(`# The Council — ${result.frame.question}`, '')
  out.push('| | |', '|---|---|')
  out.push(`| Topik | ${cell(result.topic)} |`)
  out.push(`| Status | ${STATUS_LABEL[result.status] || result.status} |`)
  out.push(`| Panel | ${cell(result.panel.map(who).join(', '))} |`)
  out.push(`| Moderator | ${cell(who(result.moderator))} |`)
  out.push(`| Ronde debat | ${debateRounds} dari maks. ${result.maxRounds}${result.rounds.some((r) => r.mode === 'vote') ? ' + suara akhir' : ''} |`)
  out.push(`| Aturan konsensus | ${result.consensus === 'majority' ? 'mayoritas' : 'bulat'} |`)
  out.push(`| Web search | ${result.web ? 'aktif untuk agen yang mendukung' : 'mati'} |`)
  out.push(`| Waktu | ${formatTime(result.startedAt)}, sekitar ${minutes} menit |`, '')

  if (result.frame.criteria.length || result.frame.context) {
    out.push('## Kriteria keberhasilan', '')
    out.push(...result.frame.criteria.map((c) => `- ${c}`))
    if (result.frame.context) out.push('', `Konteks: ${result.frame.context}`)
    out.push('')
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
        out.push(`| ${cell(p.label)} | – gagal menjawab | |`)
        continue
      }
      const notes = [...v.blocking_objections.map((o) => `**Keberatan:** ${o}`), ...v.reservations.map((r) => `Catatan: ${r}`)]
      out.push(`| ${cell(p.label)} | ${VOTE_LABEL[v.on_draft]} | ${cell(notes.join('\n'))} |`)
    }
    out.push('')
  }

  if (result.final?.agreements?.length) out.push('## Poin yang disepakati', '', ...result.final.agreements.map((a) => `- ${a}`), '')
  if (result.final?.disagreements?.length) out.push('## Perbedaan pendapat', '', ...result.final.disagreements.map((d) => `- ${d}`), '')

  const claims = collectClaims(result)
  if (claims.length) {
    out.push('## Klaim dan sumber', '')
    out.push('> Belum diverifikasi otomatis. Pengecekan sumber oleh kode dikerjakan di Fase 2; periksa sendiri sebelum dipakai.', '')
    out.push('| Klaim | Jenis | Sumber | Oleh |', '|---|---|---|---|')
    for (const c of claims) {
      const source = c.source_url ? `${c.source_url}${c.quote ? `<br>"${c.quote}"` : ''}` : '–'
      out.push(`| ${cell(c.text)} | ${c.kind} | ${cell(source)} | ${cell(`${c.by}, ronde ${c.round}`)} |`)
    }
    out.push('')
  }

  out.push('## Jalannya sidang', '')
  for (const r of result.rounds) {
    out.push(`### ${roundTitle(r)}`, '')
    for (const p of result.panel) {
      const res = r.results[p.id]
      if (!res) continue
      if (!res.ok) {
        out.push(`#### ${p.label} — gagal (${secs(res.ms)})`, '', `\`${res.error}\``, '')
        continue
      }
      const x = res.response
      out.push(`#### ${p.label} · ${secs(res.ms)}${res.repaired ? ' · format diperbaiki' : ''}`, '')
      if (x.position) out.push(x.position, '')
      if (x.proposals?.length) out.push(...x.proposals.map((pr) => `- **${pr.id}: ${pr.title}**${pr.why ? ` — ${pr.why}` : ''}`), '')
      if (x.critiques?.length) out.push('Kritik:', ...x.critiques.map((c) => `- [${c.severity}]${c.target ? ` ${c.target}:` : ''} ${c.point}`), '')
      if (x.changed_mind?.changed) out.push(`Berubah pendapat: ${x.changed_mind.what} (karena: ${x.changed_mind.because || 'tidak disebutkan'})`, '')
      if (x.vote) {
        out.push(`Suara: ${VOTE_LABEL[x.vote.on_draft]}`)
        for (const o of x.vote.blocking_objections) out.push(`- Keberatan: ${o}`)
        for (const n of x.vote.reservations) out.push(`- Catatan: ${n}`)
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

  const u = result.usage
  out.push('## Pemakaian', '')
  out.push(`- Panggilan AI: ${u.calls}${u.failedCalls ? ` (${u.failedCalls} gagal)` : ''}; total durasi panggilan ${Math.round(u.ms / 1000)} dtk (sebagian berjalan paralel)`)
  if (u.costUsd) out.push(`- \`total_cost_usd\` menurut Claude Code: $${u.costUsd.toFixed(4)}. Ini estimasi sisi klien, bukan tagihan.`)
  if (u.tokens) out.push(`- Token API (agen berbasis API): ${u.tokens}`)
  out.push('')
  return out.join('\n')
}
