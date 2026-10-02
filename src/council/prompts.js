// Prompt untuk moderator dan panelis. Semua dalam Bahasa Indonesia (K3 di docs/PLAN.md).
// System prompt dikirim sebagai argumen CLI, jadi harus satu baris tanpa tanda kutip (lihat safeArg).
// Baris "Tahap: ..." menandai jenis permintaan, juga dipakai agen palsu di test.

export const MODERATOR_SYSTEM =
  'Kamu adalah moderator sidang The Council. Kamu memimpin debat beberapa agen AI secara netral dan berbasis data serta fakta. ' +
  'Selalu jawab dalam Bahasa Indonesia dan hanya dengan satu objek JSON sesuai format yang diminta.'

export const PANELIST_SYSTEM =
  'Kamu adalah panelis dalam sidang The Council dan berdebat dengan agen AI lain. Bersikap jujur dan berbasis data serta fakta. ' +
  'Pertahankan pendapat yang didukung bukti, dan ubah pendapat hanya karena bukti atau argumen yang lebih kuat, bukan karena ingin cepat sepakat. ' +
  'Selalu jawab dalam Bahasa Indonesia dan hanya dengan satu objek JSON sesuai format yang diminta.'

export function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}… (dipotong)` : s
}

function frameBlock(frame) {
  const lines = [`Pertanyaan sidang: ${frame.question}`]
  if (frame.criteria.length) lines.push('Kriteria keberhasilan:', ...frame.criteria.map((c) => `- ${c}`))
  if (frame.context) lines.push(`Konteks: ${frame.context}`)
  return lines.join('\n')
}

// Ringkasan jawaban satu panelis untuk dibaca panelis lain atau moderator.
export function describeResponse(label, response) {
  const lines = [`## ${label}`, `Posisi: ${clip(response.position, 2500)}`]
  if (response.proposals?.length) lines.push('Usulan:', ...response.proposals.map((p) => `- ${p.id}: ${p.title}${p.why ? ` — ${clip(p.why, 400)}` : ''}`))
  if (response.claims?.length) {
    lines.push(
      'Klaim:',
      ...response.claims.map((c) => `- ${c.id} [${c.kind}] ${clip(c.text, 400)}${c.source_url ? ` (sumber: ${c.source_url})` : ''}`)
    )
  }
  if (response.critiques?.length) lines.push('Kritik:', ...response.critiques.map((c) => `- [${c.severity}]${c.target ? ` ke ${c.target}` : ''}: ${clip(c.point, 400)}`))
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

const DATA_RULES_WEB =
  'Gunakan pencarian web untuk data dan fakta terbaru. Setiap klaim berjenis "fact" wajib punya "source_url" dan "quote" (kutipan persis dari halaman itu).'
const DATA_RULES_NO_WEB =
  'Kamu tidak punya akses web di sidang ini. Klaim yang tidak bisa kamu pastikan beri jenis "estimate" atau "opinion", dan kosongkan "source_url" bila tidak yakin.'

export function panelPrompt({ frame, round, draft, focus, own, others = [], webSearch }) {
  const blind = round === 1
  const lines = [`Tahap: PANEL · Ronde ${round} (${blind ? 'blind' : 'kritik'})`, '', frameBlock(frame), '']
  if (blind) {
    lines.push('Ini ronde blind: jawab secara independen. Kamu belum melihat jawaban panelis lain.')
  } else {
    lines.push(`Draft kesimpulan moderator dari ronde ${round - 1}:`, '<<<', clip(draft, 8000), '>>>')
    if (focus) lines.push(`Fokus ronde ini dari moderator: ${focus}`)
    if (own) lines.push('', 'Posisimu di ronde sebelumnya:', '<<<', clip(own.position, 2500), '>>>')
    if (others.length) lines.push('', 'Jawaban panelis lain di ronde sebelumnya:', '', ...others.map((o) => describeResponse(o.label, o.response) + '\n'))
    lines.push(
      '',
      'Tugasmu: kritik draft dan jawaban panelis lain dengan jujur, perbarui posisimu, lalu beri suara atas draft moderator:',
      '- AGREE: draft layak jadi kesimpulan sidang.',
      '- AGREE_WITH_RESERVATIONS: setuju, dengan catatan yang tidak memblokir (tulis di "reservations").',
      '- DISAGREE: ada masalah yang harus diperbaiki dulu (tulis di "blocking_objections").',
      'Kalau kamu berubah pendapat, jelaskan bukti atau argumen yang mengubahnya di "changed_mind".'
    )
  }
  lines.push('', webSearch ? DATA_RULES_WEB : DATA_RULES_NO_WEB, 'Jangan mengarang URL, angka, atau kutipan. Maksimal 3 usulan.', '')
  lines.push('Balas hanya dengan satu objek JSON (tanpa teks lain) berformat:', '{')
  lines.push('  "position": "posisimu, ringkas tapi lengkap (maks. sekitar 200 kata)",')
  lines.push('  "proposals": [{"id": "P1", "title": "...", "why": "..."}],')
  lines.push(`  "claims": [{"id": "C1", "text": "...", "kind": "fact|estimate|opinion", "source_url": "https://... atau kosong", "quote": "kutipan persis atau kosong"}]${blind ? '' : ','}`)
  if (!blind) {
    lines.push('  "critiques": [{"target": "nama panelis atau draft", "point": "...", "severity": "blocking|minor"}],')
    lines.push('  "changed_mind": {"changed": false, "what": "", "because": ""},')
    lines.push('  "vote": {"on_draft": "AGREE|AGREE_WITH_RESERVATIONS|DISAGREE", "reservations": [], "blocking_objections": []}')
  }
  lines.push('}')
  return lines.join('\n')
}

export function judgePrompt({ frame, round, previousDraft, responses, failed = [] }) {
  const lines = [`Tahap: JUDGE · Ronde ${round}`, '', frameBlock(frame), '']
  if (previousDraft) lines.push('Draft kesimpulan sebelumnya:', '<<<', clip(previousDraft, 8000), '>>>', '')
  lines.push(`Jawaban panelis di ronde ${round}:`, '', ...responses.map((r) => describeResponse(r.label, r.response) + '\n'))
  for (const f of failed) lines.push(`## ${f.label}`, 'Gagal menjawab di ronde ini.', '')
  lines.push(
    'Tugasmu sebagai moderator:',
    '1. Rangkum poin yang disepakati dan yang masih diperdebatkan.',
    '2. Susun draft kesimpulan terbaik yang menjawab pertanyaan sidang dan memenuhi kriterianya. Gunakan hanya argumen dan klaim dari panelis; jangan menambah fakta baru tanpa sumber. Sebutkan ketidakpastian dengan jujur.',
    previousDraft ? '3. Perbaiki draft berdasarkan kritik dan keberatan yang memblokir. Jangan mengabaikan keberatan hanya karena datang dari minoritas.' : '3. Kalau panelis berbeda pendapat, jangan memaksakan kesepakatan; tulis perbedaannya.',
    '4. Tentukan fokus untuk ronde berikutnya.',
    '',
    'Balas hanya dengan JSON berformat:',
    '{"summary": "ringkasan 1-3 kalimat", "agreements": ["..."], "disagreements": ["..."], "draft": "draft kesimpulan lengkap, boleh Markdown", "next_focus": "..."}'
  )
  return lines.join('\n')
}

export function votePrompt({ frame, draft }) {
  return [
    'Tahap: VOTE',
    '',
    frameBlock(frame),
    '',
    'Draft kesimpulan final dari moderator:',
    '<<<',
    clip(draft, 8000),
    '>>>',
    '',
    'Ini pemungutan suara terakhir. Nilai apakah draft ini layak jadi kesimpulan sidang:',
    '- AGREE: layak.',
    '- AGREE_WITH_RESERVATIONS: layak, dengan catatan yang tidak memblokir.',
    '- DISAGREE: tidak layak; tulis alasannya di "blocking_objections".',
    '',
    'Balas hanya dengan JSON berformat:',
    '{"vote": {"on_draft": "AGREE|AGREE_WITH_RESERVATIONS|DISAGREE", "reservations": [], "blocking_objections": []}}'
  ].join('\n')
}

export function repairPrompt({ prompt, previous, error }) {
  return [
    `Jawabanmu sebelumnya tidak bisa dipakai karena: ${error}.`,
    '',
    'Jawaban sebelumnya:',
    '<<<',
    clip(previous, 12000),
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
