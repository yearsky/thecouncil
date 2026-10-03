// Tampilan sidang di terminal seperti chat. Jawaban agen dicetak utuh saat selesai supaya output paralel
// tidak bercampur; baris status di bawah menunjukkan agen yang masih berpikir (hanya jika output terminal).

import { FLAG_LABEL, STATUS_LABEL } from '../council/report.js'
import { VERIFY_STATUS } from '../evidence/verify.js'
import { createStyle } from './style.js'

const VOTE_ICON = { AGREE: '✔', AGREE_WITH_RESERVATIONS: '◐', DISAGREE: '✖' }
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const secs = (ms) => `${(ms / 1000).toFixed(1)} dtk`

export function indent(text, prefix = '  ') {
  return String(text)
    .split(/\r?\n/)
    .map((line) => prefix + line)
    .join('\n')
}

export function createTerminalRenderer({ out = process.stdout, style = createStyle(), live = Boolean(out.isTTY), maxText = 1500 } = {}) {
  const labels = {}
  let moderator = 'Moderator'
  const pending = new Map()
  let timer = null
  let frameNo = 0
  let statusShown = false

  const clip = (text) => (text.length > maxText ? `${text.slice(0, maxText)}… ${style.dim('(lengkap di laporan)')}` : text)

  function clearStatus() {
    if (statusShown) out.write('\r\x1b[2K')
    statusShown = false
  }
  function drawStatus() {
    if (!live || !pending.size) return
    const now = Date.now()
    const parts = [...pending].map(([id, start]) => `${labels[id] || id} ${Math.floor((now - start) / 1000)}s`)
    const line = `${SPINNER[frameNo++ % SPINNER.length]} menunggu: ${parts.join(' · ')}`
    out.write(style.dim(line.slice(0, (out.columns || 80) - 1)))
    statusShown = true
  }
  function print(text = '') {
    clearStatus()
    out.write(text + '\n')
    drawStatus()
  }
  function tick() {
    clearStatus()
    drawStatus()
  }
  function startTimer() {
    if (live && !timer) timer = setInterval(tick, 1000)
  }
  function stopTimerIfIdle() {
    if (!pending.size && timer) {
      clearInterval(timer)
      timer = null
      clearStatus()
    }
  }

  function printResponse(label, event) {
    const r = event.response
    print(`${style.bold(style.cyan(`[${label}]`))} ${style.dim(secs(event.ms) + (event.repaired ? ' · format diperbaiki' : ''))}`)
    if (r.position) print(indent(clip(r.position)))
    for (const p of r.proposals || []) print(`  ${style.bold('▸')} ${p.id}: ${p.title}`)
    if (r.claims?.length || r.cited_claims?.length) {
      const sourced = (r.claims || []).filter((c) => c.source_url).length
      const parts = []
      if (r.claims?.length) parts.push(`${r.claims.map((c) => c.id).join(', ')} (${sourced} dengan sumber)`)
      if (r.cited_claims?.length) parts.push(`merujuk ${r.cited_claims.join(', ')}`)
      print(style.dim(`  klaim: ${parts.join(' · ')}`))
    }
    for (const c of (r.critiques || []).filter((c) => c.severity === 'blocking')) print(`  ${style.yellow('kritik')}${c.target ? ` ke ${c.target}` : ''}: ${c.point}`)
    if (r.changed_mind?.changed) print(`  ${style.yellow('berubah pendapat')}: ${r.changed_mind.what}${r.changed_mind.because ? ` (karena ${r.changed_mind.because})` : ''}`)
    if (r.vote) {
      const v = r.vote
      const objections = v.blocking_objections.length ? ` — keberatan: ${v.blocking_objections.join('; ')}` : ''
      print(`  suara: ${VOTE_ICON[v.on_draft]} ${v.on_draft}${objections}`)
      for (const n of v.reservations) print(style.dim(`    catatan: ${n}`))
    }
    print()
  }

  function handle(event) {
    switch (event.type) {
      case 'session_started':
        for (const p of event.panel) labels[p.id] = p.alias ? `${p.label} · ${p.alias}` : p.label
        moderator = `Moderator · ${event.moderator.label}`
        print(style.bold('━━ The Council ━━'))
        print(`Topik: ${event.topic}`)
        print(style.dim(`Panel: ${event.panel.map((p) => `${p.label}${p.model ? ` (${p.model})` : ''}${p.alias ? ` = ${p.alias}` : ''}`).join(' · ')}`))
        print(
          style.dim(
            `Moderator: ${event.moderator.label}${event.moderator.model ? ` (${event.moderator.model})` : ''} · maks. ${event.maxRounds} ronde · konsensus: ${event.consensus === 'majority' ? 'mayoritas' : 'bulat'} · web: ${event.web ? 'aktif' : 'mati'} · verifikasi: ${event.verify ? 'aktif' : 'mati'}`
          )
        )
        for (const m of event.memory || []) print(style.dim(`Melanjutkan: ${m.id} — ${m.question} (${m.claims} klaim ✅ dibawa)`))
        print()
        break
      case 'framed':
        print(`${style.bold(style.cyan(`[${moderator}]`))} Pertanyaan: ${event.question}`)
        for (const c of event.criteria) print(`  • ${c}`)
        if (event.context) print(style.dim(`  Konteks: ${event.context}`))
        print()
        break
      case 'warning':
        print(style.yellow(`⚠ ${event.message}`))
        break
      case 'round_started': {
        const title = event.mode === 'blind' ? `Ronde ${event.round} (blind)` : event.mode === 'critique' ? `Ronde ${event.round} (kritik)` : 'Pemungutan suara akhir'
        print(style.bold(`── ${title} ${'─'.repeat(Math.max(3, 40 - title.length))}`))
        if (event.devilsAdvocate) print(style.dim(`Devil's advocate: ${labels[event.devilsAdvocate] || event.devilsAdvocate}`))
        break
      }
      case 'verified': {
        const counts = Object.entries(event.counts)
          .map(([s, n]) => `${VERIFY_STATUS[s]?.icon || s} ${n}`)
          .join(' · ')
        print(`${style.bold('[Verifier]')} ${event.total} klaim dicek: ${counts}`)
        for (const c of event.claims.filter((c) => c.status === 'unreachable')) print(style.red(`  ${c.id} ❌ ${c.detail}: ${c.source_url}`))
        print()
        break
      }
      case 'flags':
        for (const f of event.flags) print(style.yellow(`⚠ ${labels[f.agent] || f.agent}: ${FLAG_LABEL[f.type] || f.type}${f.detail ? ` (${f.detail})` : ''}`))
        break
      case 'agent_started':
        pending.set(event.agent, Date.now())
        startTimer()
        tick()
        break
      case 'agent_finished':
        pending.delete(event.agent)
        if (event.response.position) printResponse(labels[event.agent] || event.agent, event)
        else {
          const v = event.response.vote
          print(`${style.bold(style.cyan(`[${labels[event.agent] || event.agent}]`))} ${VOTE_ICON[v.on_draft]} ${v.on_draft}${v.blocking_objections.length ? ` — keberatan: ${v.blocking_objections.join('; ')}` : ''}`)
        }
        stopTimerIfIdle()
        break
      case 'agent_failed':
        pending.delete(event.agent)
        print(style.red(`[${labels[event.agent] || event.agent}] ✖ gagal (${secs(event.ms)}): ${event.error}`))
        print()
        stopTimerIfIdle()
        break
      case 'votes': {
        const label = event.status === 'unanimous' ? style.green('BULAT') : event.status === 'majority' ? style.yellow('MAYORITAS') : style.red('BELUM SEPAKAT')
        print(`${style.bold('Suara')} atas draft ronde ${event.draftRound}: ${event.accepted.length}/${event.total} setuju → ${label}`)
        print()
        break
      }
      case 'judged':
        print(`${style.bold(style.cyan(`[${moderator}]`))} ${event.summary}`)
        if (event.agreements.length) print(indent(`Sepakat: ${event.agreements.join('; ')}`))
        if (event.disagreements.length) print(indent(`Berbeda: ${event.disagreements.join('; ')}`))
        if (event.next_focus) print(style.dim(indent(`Fokus berikutnya: ${event.next_focus}`)))
        print()
        break
      case 'finished':
        print(style.bold(`━━ Hasil: ${STATUS_LABEL[event.status] || event.status} (${event.decidedBy === 'vote' ? 'suara akhir' : `ronde ${event.round}`}) ━━`))
        if (event.summary) print(event.summary)
        if (event.report) print(style.dim(`Laporan: ${event.report}`))
        break
      default:
        break
    }
  }

  return {
    handle,
    close() {
      if (timer) clearInterval(timer)
      timer = null
      clearStatus()
    }
  }
}
