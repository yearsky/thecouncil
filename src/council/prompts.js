// Prompt untuk moderator dan panelis. Semua dalam Bahasa Indonesia (K3 di docs/PLAN.md).
//
// Hemat token tanpa memotong isi (docs/PLAN.md §16):
// - Bagian statis (pertanyaan sidang, aturan, format jawaban) selalu di depan dan identik antar-ronde,
//   supaya bisa memanfaatkan prompt caching penyedia. Bagian yang berubah (ronde, draft, jawaban) di belakang.
// - Klaim ditulis sekali di daftar klaim bersama (K1, K2, …); jawaban panelis hanya merujuk ID-nya.
// - Teks panelis dan draft tidak dipotong; batas di bawah hanya pengaman untuk kasus ekstrem.
//
// System prompt dikirim sebagai argumen CLI, jadi harus satu baris tanpa tanda kutip (lihat safeArg).
// Baris "Tahap: ... · Ronde N" menandai jenis permintaan, juga dipakai agen palsu di test.

import { registryBlock } from './claims.js'

export const MODERATOR_SYSTEM =
  'Kamu adalah moderator sidang The Council. Kamu memimpin debat beberapa agen AI secara netral dan berbasis data serta fakta. ' +
  'Selalu jawab dalam Bahasa Indonesia dan hanya dengan satu objek JSON sesuai format yang diminta.'

export const PANELIST_SYSTEM =
  'Kamu adalah panelis dalam sidang The Council dan berdebat dengan agen AI lain. Bersikap jujur dan berbasis data serta fakta. ' +
  'Pertahankan pendapat yang didukung bukti, dan ubah pendapat hanya karena bukti atau argumen yang lebih kuat, bukan karena ingin cepat sepakat. ' +
  'Selalu jawab dalam Bahasa Indonesia dan hanya dengan satu objek JSON sesuai format yang diminta.'

// Pengaman ukuran, bukan alat penghemat: teks sepanjang ini hampir pasti jawaban yang rusak.
export const SAFETY_LIMIT = 60000

export function clip(text, max = SAFETY_LIMIT) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}… (dipotong pengaman: ${s.length - max} karakter dihapus)` : s
}

function frameBlock(frame) {
  const lines = [`Pertanyaan sidang: ${frame.question}`]
  if (frame.criteria.length) lines.push('Kriteria keberhasilan:', ...frame.criteria.map((c) => `- ${c}`))
  if (frame.context) lines.push(`Konteks: ${frame.context}`)
  return lines.join('\n')
}

const VERIFY_RULE =
  'Status klaim di daftar klaim diperiksa oleh program, bukan oleh panelis: ✅ kutipan ditemukan di sumber; ⚠️ sumber ada tapi kutipan tidak cocok atau tidak ada; ❔ tidak bisa dicek otomatis; ❌ sumber tidak ada; ➖ tanpa sumber.'

export function panelRules({ webSearch, searchBudget }) {
  return [
    'Aturan panelis:',
    webSearch
      ? `- Gunakan pencarian web untuk data terbaru${searchBudget ? `, maksimal ${searchBudget} pencarian per ronde` : ''}. Jangan mencari ulang klaim yang sudah ✅.`
      : '- Kamu tidak punya akses web. Pakai klaim ✅ di daftar klaim (beserta kutipannya) sebagai bukti. Klaim baru tanpa sumber beri jenis "estimate" atau "opinion".',
    '- Jangan mengarang URL, angka, atau kutipan. Klaim baru berjenis "fact" wajib punya "source_url" dan "quote" (kutipan persis dari halaman itu).',
    '- Klaim yang sudah ada di daftar klaim cukup dirujuk ID-nya di "cited_claims"; jangan ditulis ulang di "claims".',
    `- ${VERIFY_RULE} Jangan bersandar pada klaim ⚠️ atau ❌.`,
    '- Tulis ringkas tapi lengkap: posisi sekitar 200 kata, maksimal 3 usulan. Rujuk panelis lain dengan aliasnya (mis. Panelis A).',
    '',
    'Format jawaban: satu objek JSON tanpa teks lain.',
    '{',
    '  "position": "posisimu",',
    '  "proposals": [{"id": "P1", "title": "...", "why": "..."}],',
    '  "claims": [{"text": "klaim baru", "kind": "fact|estimate|opinion", "source_url": "https://... atau kosong", "quote": "kutipan persis atau kosong"}],',
    '  "cited_claims": ["K1"],',
    '  "critiques": [{"target": "Panelis X, draft, atau ID klaim", "point": "...", "severity": "blocking|minor"}],',
    '  "changed_mind": {"changed": false, "what": "", "because": "bukti atau argumen yang mengubah pendapatmu, rujuk ID klaim bila ada"},',
    '  "vote": {"on_draft": "AGREE|AGREE_WITH_RESERVATIONS|DISAGREE", "reservations": [], "blocking_objections": []}',
    '}',
    'Di ronde 1 (blind) "critiques", "changed_mind", dan "vote" boleh dikosongkan. Mulai ronde 2, "vote" wajib diisi.',
    'Arti suara: AGREE = draft layak jadi kesimpulan; AGREE_WITH_RESERVATIONS = setuju dengan catatan yang tidak memblokir; DISAGREE = ada masalah yang harus diperbaiki dulu (tulis di "blocking_objections"). Jangan menulis keberatan pemblokir bila kamu setuju.'
  ].join('\n')
}

// Ringkasan jawaban satu panelis untuk dibaca panelis lain atau moderator. Klaim cukup ditulis ID-nya
// karena isinya sudah ada di daftar klaim.
export function describeResponse(label, response) {
  const lines = [`## ${label}`, `Posisi: ${clip(response.position)}`]
  if (response.proposals?.length) lines.push('Usulan:', ...response.proposals.map((p) => `- ${p.id}: ${p.title}${p.why ? ` — ${p.why}` : ''}`))
  const ids = [...new Set([...(response.claims || []).map((c) => c.id), ...(response.cited_claims || [])])]
  if (ids.length) lines.push(`Klaim yang dipakai: ${ids.join(', ')}`)
  if (response.critiques?.length) lines.push('Kritik:', ...response.critiques.map((c) => `- [${c.severity}]${c.target ? ` ke ${c.target}` : ''}: ${c.point}`))
  if (response.changed_mind?.changed) lines.push(`Berubah pendapat: ${response.changed_mind.what} (karena: ${response.changed_mind.because || 'tidak disebutkan'})`)
  if (response.vote) {
    const v = response.vote
    lines.push(`Suara atas draft: ${v.on_draft}`)
    if (v.reservations.length) lines.push(`Catatan: ${v.reservations.join('; ')}`)
    if (v.blocking_objections.length) lines.push(`Keberatan yang memblokir: ${v.blocking_objections.join('; ')}`)
  }
  return lines.join('\n')
}

export function framePrompt(topic) {
  return [
    'Tahap: FRAME',
    '',
    'Permintaan pengguna:',
    '<<<',
    topic,
    '>>>',
    '',
    'Ubah permintaan ini menjadi pertanyaan sidang yang jelas dan 3-5 kriteria keberhasilan yang bisa diperiksa. Jangan menjawab pertanyaannya.',
    '',
    'Balas hanya dengan JSON berformat:',
    '{"question": "pertanyaan sidang", "criteria": ["kriteria 1", "kriteria 2"], "context": "asumsi atau batasan penting, boleh kosong"}'
  ].join('\n')
}

export const DEVILS_ADVOCATE =
  'Di ronde ini kamu mendapat giliran sebagai devil\'s advocate: cari kelemahan terbesar draft dan tulis minimal satu kritik serius. ' +
  'Suaramu tetap harus jujur; kalau kelemahannya tidak memblokir, kamu boleh tetap setuju.'

export function panelPrompt({ frame, round, alias, draft, focus, own, others = [], claims = [], aliasOf, webSearch, searchBudget, devilsAdvocate = false }) {
  const blind = round === 1
  const lines = [frameBlock(frame), '', panelRules({ webSearch, searchBudget }), '', `Tahap: PANEL · Ronde ${round} (${blind ? 'blind' : 'kritik'})`]
  if (alias) lines.push(`Kamu adalah ${alias}.`)
  if (devilsAdvocate) lines.push(DEVILS_ADVOCATE)
  const registry = registryBlock(claims, aliasOf)
  if (blind) {
    lines.push('Ini ronde blind: jawab secara independen. Kamu belum melihat jawaban panelis lain.')
  } else {
    lines.push('', `Draft kesimpulan moderator dari ronde ${round - 1}:`, '<<<', clip(draft), '>>>')
    if (focus) lines.push(`Fokus ronde ini dari moderator: ${focus}`)
    if (registry) lines.push('', registry)
    if (own) lines.push('', 'Posisimu di ronde sebelumnya:', '<<<', clip(own.position), '>>>')
    if (others.length) lines.push('', 'Jawaban panelis lain di ronde sebelumnya:', '', ...others.map((o) => describeResponse(o.label, o.response) + '\n'))
    lines.push(
      '',
      'Tugasmu: kritik draft dan jawaban panelis lain dengan jujur, perbarui posisimu, lalu beri suara atas draft moderator.',
      'Kalau kamu berubah pendapat, jelaskan bukti atau argumen yang mengubahnya di "changed_mind".'
    )
  }
  return lines.join('\n')
}

export function moderatorRules() {
  return [
    'Aturan moderator:',
    '- Netral: nilai argumen dan bukti, bukan siapa yang mengatakannya. Panelis hanya dikenal lewat aliasnya.',
    `- ${VERIFY_RULE}`,
    '- Kesimpulan hanya boleh bersandar pada klaim ✅. Klaim ❔ boleh disebut dengan label "belum terverifikasi". Klaim ⚠️, ❌, dan ➖ jangan dipakai sebagai dasar.',
    '- Rujuk klaim dengan ID-nya dalam kurung siku, mis. [K3]. Jangan menambah fakta baru tanpa sumber.',
    '- Jangan memaksakan kesepakatan dan jangan mengabaikan keberatan hanya karena datang dari minoritas. Tulis perbedaan pendapat apa adanya.',
    '- Tulis draft ringkas (usahakan maksimal sekitar 1.000 kata): utamakan keputusan, alasan, dan angka kunci, bukan pengulangan jawaban panelis.',
    '',
    'Format jawaban: satu objek JSON tanpa teks lain.',
    '{"summary": "ringkasan 1-3 kalimat", "agreements": ["..."], "disagreements": ["..."], "draft": "draft kesimpulan lengkap, boleh Markdown", "next_focus": "..."}'
  ].join('\n')
}

export function judgePrompt({ frame, round, previousDraft, responses, failed = [], claims = [], aliasOf }) {
  const lines = [frameBlock(frame), '', moderatorRules(), '', `Tahap: JUDGE · Ronde ${round}`]
  if (previousDraft) lines.push('', 'Draft kesimpulan sebelumnya:', '<<<', clip(previousDraft), '>>>')
  const registry = registryBlock(claims, aliasOf)
  if (registry) lines.push('', registry)
  lines.push('', `Jawaban panelis di ronde ${round}:`, '', ...responses.map((r) => describeResponse(r.label, r.response) + '\n'))
  for (const f of failed) lines.push(`## ${f.label}`, 'Gagal menjawab di ronde ini.', '')
  lines.push(
    'Tugasmu: rangkum poin yang disepakati dan yang masih diperdebatkan, susun draft kesimpulan terbaik yang menjawab pertanyaan sidang dan memenuhi kriterianya,',
    previousDraft ? 'perbaiki draft sebelumnya berdasarkan kritik dan keberatan yang memblokir, lalu tentukan fokus untuk ronde berikutnya.' : 'lalu tentukan fokus untuk ronde berikutnya.'
  )
  return lines.join('\n')
}

export function voteRules() {
  return [
    'Aturan pemungutan suara akhir:',
    '- AGREE: draft layak jadi kesimpulan. AGREE_WITH_RESERVATIONS: layak, dengan catatan yang tidak memblokir. DISAGREE: tidak layak; tulis alasannya di "blocking_objections".',
    '- Jangan menulis keberatan pemblokir bila kamu setuju.',
    '- Kalau suaramu berbeda dari ronde sebelumnya, jelaskan alasannya di "change_reason".',
    `- ${VERIFY_RULE}`,
    '',
    'Format jawaban: satu objek JSON tanpa teks lain.',
    '{"vote": {"on_draft": "AGREE|AGREE_WITH_RESERVATIONS|DISAGREE", "reservations": [], "blocking_objections": [], "change_reason": ""}}'
  ].join('\n')
}

export function votePrompt({ frame, draft, alias, previousVote, claims = [], aliasOf }) {
  const lines = [frameBlock(frame), '', voteRules(), '', 'Tahap: VOTE']
  if (alias) lines.push(`Kamu adalah ${alias}.`)
  if (previousVote) {
    const objections = previousVote.blocking_objections.length ? ` (keberatan: ${previousVote.blocking_objections.join('; ')})` : ''
    lines.push(`Suaramu di ronde sebelumnya: ${previousVote.on_draft}${objections}`)
  }
  lines.push('', 'Draft kesimpulan final dari moderator:', '<<<', clip(draft), '>>>')
  const registry = registryBlock(claims, aliasOf)
  if (registry) lines.push('', registry)
  lines.push('', 'Ini pemungutan suara terakhir. Nilai apakah draft ini layak jadi kesimpulan sidang.')
  return lines.join('\n')
}

export function repairPrompt({ prompt, previous, error }) {
  return [
    `Jawabanmu sebelumnya tidak bisa dipakai karena: ${error}.`,
    '',
    'Jawaban sebelumnya:',
    '<<<',
    clip(previous),
    '>>>',
    '',
    'Instruksi aslinya:',
    '<<<',
    prompt,
    '>>>',
    '',
    'Tulis ulang jawabanmu sebagai SATU objek JSON yang valid sesuai format di instruksi asli, tanpa teks lain. Jangan mengubah isinya kecuali untuk melengkapi field yang wajib.'
  ].join('\n')
}
