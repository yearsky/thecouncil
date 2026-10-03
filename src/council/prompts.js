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

export const RESEARCHER_SYSTEM =
  'Kamu adalah peneliti sidang The Council. Tugasmu menggali temuan dari paper, thesis, laporan industri, regulasi, dan data yang tidak umum diketahui, sebagai bahan berpikir panelis. Kamu tidak memilih jawaban akhir. ' +
  'Jujur: jangan mengarang sumber, angka, atau kutipan. Selalu jawab dalam Bahasa Indonesia dan hanya dengan satu objek JSON sesuai format yang diminta.'

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

// Pertanyaan sidang + jawaban klise yang harus dilampaui + latar (memori sidang sebelumnya, literatur, hasil
// riset). Semuanya tetap selama ronde debat, jadi ikut bagian statis.
function frameBlock(frame, background = '') {
  const lines = [`Pertanyaan sidang: ${frame.question}`]
  if (frame.criteria.length) lines.push('Kriteria keberhasilan:', ...frame.criteria.map((c) => `- ${c}`))
  if (frame.context) lines.push(`Konteks: ${frame.context}`)
  if (frame.obvious?.length) {
    lines.push(
      'Jawaban klise yang harus dilampaui (yang paling mungkin diberikan kebanyakan orang atau AI):',
      ...frame.obvious.map((o) => `- ${o}`),
      'Usulan yang sama dengan daftar ini hanya layak kalau punya pembeda mendasar yang didukung sumber.'
    )
  }
  if (background) lines.push('', background)
  return lines.join('\n')
}

// Lensa berpikir panelis. Semua panelis bisa memakai model yang sama, jadi lensa yang berbeda membuat ronde
// blind benar-benar menghasilkan sudut pandang berbeda, bukan tiga kali ide yang paling umum.
export const LENSES = [
  {
    id: 'research',
    label: 'Peneliti',
    text: 'berangkat dari temuan paper dan thesis, terutama keterbatasan metode dan "penelitian lanjutan" yang disarankan penulis; cari temuan yang belum dijadikan produk'
  },
  {
    id: 'industry',
    label: 'Orang dalam industri',
    text: 'berangkat dari alur kerja nyata: siapa yang sudah mengeluarkan uang untuk masalah ini, pos anggaran mana, kewajiban regulasi apa yang memaksa mereka, dan di mana prosesnya macet'
  },
  {
    id: 'contrarian',
    label: 'Investor kontrarian',
    text: 'berangkat dari apa yang baru berubah (regulasi, data terbuka, biaya teknologi) dan apa yang diabaikan pemain besar; curigai ide yang terdengar populer'
  }
]

export const lensLine = (lens) => (lens ? `Lensa berpikirmu: ${lens.label} — ${lens.text}. Pakai lensa ini untuk menemukan sudut yang tidak dilihat panelis lain.` : '')

const VERIFY_RULE =
  'Status klaim di daftar klaim diperiksa oleh program, bukan oleh panelis: ✅ kutipan ditemukan di sumber; ⚠️ sumber ada tapi kutipan tidak cocok atau tidak ada; ❔ tidak bisa dicek otomatis; ❌ sumber tidak ada; ➖ tanpa sumber.'

export function panelRules({ webSearch, searchBudget }) {
  return [
    'Aturan panelis:',
    webSearch
      ? `- Gunakan pencarian web${searchBudget ? ` (maksimal ${searchBudget} pencarian per ronde)` : ''} untuk menemukan, bukan hanya membenarkan: paper, thesis, laporan industri, regulasi baru, dan data yang tidak umum diketahui. Jangan menghabiskan pencarian untuk angka yang semua orang tahu. Jangan mencari ulang klaim yang sudah ✅.`
      : '- Kamu tidak punya akses web. Pakai klaim ✅ di daftar klaim (beserta kutipannya) sebagai bukti. Klaim baru tanpa sumber beri jenis "estimate" atau "opinion".',
    '- Usulan harus tajam dan spesifik. Untuk tiap usulan isi "basis" (ID insight I, sumber literatur S, atau klaim K yang mendasarinya), "non_obvious" (kenapa ini tidak terpikir oleh kebanyakan orang), dan "why_now" (apa yang baru berubah sehingga ini mungkin sekarang).',
    '- Klaim dari sumber literatur S: isi "source_url" dengan ID sumbernya (mis. "S3") dan "quote" dengan kutipan persis dari judul atau abstraknya.',
    '- Jangan mengarang URL, angka, atau kutipan. Klaim baru berjenis "fact" wajib punya "source_url" dan "quote" (kutipan persis dari halaman itu).',
    '- Klaim yang sudah ada di daftar klaim cukup dirujuk ID-nya di "cited_claims"; jangan ditulis ulang di "claims".',
    `- ${VERIFY_RULE} Jangan bersandar pada klaim ⚠️ atau ❌.`,
    '- Tulis ringkas tapi lengkap: posisi sekitar 200 kata, maksimal 3 usulan. Rujuk panelis lain dengan aliasnya (mis. Panelis A).',
    '',
    'Format jawaban: satu objek JSON tanpa teks lain.',
    '{',
    '  "position": "posisimu",',
    '  "proposals": [{"id": "P1", "title": "...", "why": "...", "basis": ["I2", "S3", "K4"], "non_obvious": "...", "why_now": "..."}],',
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
  if (response.proposals?.length) {
    lines.push('Usulan:')
    for (const p of response.proposals) {
      lines.push(`- ${p.id}: ${p.title}${p.why ? ` — ${p.why}` : ''}${p.basis?.length ? ` [dasar: ${p.basis.join(', ')}]` : ''}`)
      if (p.non_obvious) lines.push(`  Tidak umum karena: ${p.non_obvious}`)
      if (p.why_now) lines.push(`  Kenapa sekarang: ${p.why_now}`)
    }
  }
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

export function framePrompt(topic, memoryText = '', { research = false } = {}) {
  return [
    'Tahap: FRAME',
    '',
    'Permintaan pengguna:',
    '<<<',
    topic,
    '>>>',
    '',
    ...(memoryText ? [memoryText, ''] : []),
    'Ubah permintaan ini menjadi pertanyaan sidang yang jelas dan 3-5 kriteria keberhasilan yang bisa diperiksa. Jangan menjawab pertanyaannya.',
    'Kalau permintaannya meminta ide, strategi, atau solusi:',
    '- tambahkan kriteria "tidak klise: berangkat dari temuan yang tidak umum diketahui, dan jelas kenapa baru mungkin sekarang";',
    '- isi "obvious" dengan 5-8 jawaban yang paling mungkin diberikan kebanyakan orang atau AI untuk permintaan ini (jawaban klise), supaya panelis bisa melampauinya. Untuk pertanyaan lain "obvious" boleh kosong.',
    ...(research
      ? [
          'Isi "queries" dengan 4-6 kata kunci pencarian literatur ilmiah (paper, thesis, laporan) yang paling mungkin memunculkan temuan tidak umum. Campur bahasa Inggris dan Indonesia, spesifik (nama masalah, populasi, metode), bukan kata umum seperti "AI startup". Arahkan sebagian ke keterbatasan atau masalah yang belum terpecahkan.'
        ]
      : []),
    '',
    'Balas hanya dengan JSON berformat:',
    `{"question": "pertanyaan sidang", "criteria": ["kriteria 1", "kriteria 2"], "context": "asumsi atau batasan penting, boleh kosong", "obvious": ["jawaban klise 1"]${research ? ', "queries": ["kata kunci 1"]' : ''}}`
  ].join('\n')
}

export function researchRules({ webSearch, searchBudget }) {
  return [
    'Aturan peneliti:',
    '- Baca sumber literatur S1, S2, … (judul dan abstrak diambil program dari indeks ilmiah). Cari temuan yang mengejutkan, angka yang tidak umum, keterbatasan metode, dan "penelitian lanjutan" yang disarankan penulis: di situ sering ada peluang yang belum digarap.',
    webSearch
      ? `- Gunakan pencarian web${searchBudget ? ` (maksimal ${searchBudget} pencarian)` : ''} untuk laporan industri atau pemerintah terbaru, regulasi yang baru atau akan berlaku, data terbuka baru, dan thesis/skripsi di repositori kampus Indonesia (kata "skripsi", "tesis", "repository", atau situs ac.id). Utamakan halaman HTML yang memuat abstrak, bukan file PDF, supaya kutipannya bisa dicek program.`
      : '- Kamu tidak punya akses web; pakai sumber literatur S dan klaim ✅ yang ada.',
    '- Jangan menulis pengetahuan umum yang semua orang tahu (mis. "UMKM sangat banyak", "pengguna smartphone tinggi"). Setiap insight harus menjawab: apa yang tidak diketahui kebanyakan orang, dan apa artinya untuk pertanyaan sidang?',
    '- Setiap insight wajib punya sumber di "sources": ID literatur (mis. "S3") atau klaim baru yang kamu tulis di "claims" (rujuk dengan id-nya, mis. "C1").',
    '- Klaim dari literatur: "source_url" diisi ID sumbernya (mis. "S3") dan "quote" kutipan persis dari judul atau abstraknya. Klaim dari web: URL halaman dan kutipan persis dari halaman itu.',
    '- Jangan mengarang URL, angka, atau kutipan. Yang belum pasti tulis di "open_question".',
    `- ${VERIFY_RULE}`,
    '',
    'Format jawaban: satu objek JSON tanpa teks lain.',
    '{',
    '  "insights": [{"id": "I1", "finding": "temuan, 1-3 kalimat", "sources": ["S3", "C1"], "why_non_obvious": "kenapa ini tidak umum diketahui", "implication": "peluang atau konsekuensinya untuk pertanyaan sidang", "open_question": "yang masih harus dicek"}],',
    '  "gaps": ["masalah yang belum terpecahkan menurut sumber"],',
    '  "why_now": ["perubahan terbaru (regulasi, data, teknologi, biaya) yang membuka peluang, sebut sumbernya"],',
    '  "claims": [{"id": "C1", "text": "...", "kind": "fact|estimate|opinion", "source_url": "https://... atau S3", "quote": "kutipan persis"}]',
    '}',
    'Tulis 6-10 insight. Lebih baik 6 insight tajam daripada 10 yang umum.'
  ].join('\n')
}

// Daftar sumber literatur untuk prompt. Judul dan abstrak diambil program (src/evidence/scholar.js).
export function literatureBlock(papers = []) {
  if (!papers.length) return ''
  const lines = ['Sumber literatur (judul dan abstrak diambil program dari indeks ilmiah, bukan ditulis AI; rujuk dengan ID-nya, mis. [S3]):']
  for (const p of papers) {
    const meta = [p.year || 'tahun ?', p.venue, p.citations != null ? `${p.citations} sitasi` : ''].filter(Boolean).join(', ')
    lines.push(`${p.id} · ${p.title} (${meta}) · ${p.url}`)
    if (p.abstract) lines.push(`Abstrak: ${p.abstract}`)
    if (p.tldr) lines.push(`Ringkas: ${p.tldr}`)
  }
  return lines.join('\n')
}

// Hasil tahap riset untuk prompt panelis dan moderator.
export function researchBlock(research) {
  if (!research?.insights?.length) return ''
  const lines = ['Hasil riset (insight adalah tafsiran peneliti; buktinya adalah sumber S dan klaim K di baliknya). Rujuk dengan ID-nya, mis. [I2]:']
  for (const x of research.insights) {
    lines.push(`${x.id}: ${x.finding}${x.sources.length ? ` (sumber: ${x.sources.join(', ')})` : ' (tanpa sumber)'}`)
    if (x.why_non_obvious) lines.push(`  Tidak umum karena: ${x.why_non_obvious}`)
    if (x.implication) lines.push(`  Implikasi: ${x.implication}`)
    if (x.open_question) lines.push(`  Belum pasti: ${x.open_question}`)
  }
  if (research.gaps?.length) lines.push('Masalah yang belum terpecahkan:', ...research.gaps.map((g) => `- ${g}`))
  if (research.why_now?.length) lines.push('Yang baru berubah (why now):', ...research.why_now.map((w) => `- ${w}`))
  return lines.join('\n')
}

export function researchPrompt({ frame, memoryText, literature = [], webSearch, searchBudget }) {
  const lines = [frameBlock(frame, memoryText), '', researchRules({ webSearch, searchBudget }), '', 'Tahap: RESEARCH']
  const block = literatureBlock(literature)
  lines.push('', block || 'Pencarian literatur otomatis tidak menghasilkan sumber (atau dimatikan). Andalkan pencarian web dan tulis sumbernya sebagai klaim.')
  lines.push('', 'Tugasmu: tulis insight yang paling berguna untuk menjawab pertanyaan sidang dengan cara yang tidak klise.')
  return lines.join('\n')
}

export const DEVILS_ADVOCATE =
  'Di ronde ini kamu mendapat giliran sebagai devil\'s advocate: cari kelemahan terbesar draft dan tulis minimal satu kritik serius. ' +
  'Uji juga apakah ide di draft sebenarnya jawaban klise dengan nama baru. ' +
  'Suaramu tetap harus jujur; kalau kelemahannya tidak memblokir, kamu boleh tetap setuju.'

export function panelPrompt({ frame, background, round, alias, lens, draft, focus, own, others = [], claims = [], aliasOf, webSearch, searchBudget, devilsAdvocate = false, researched = false }) {
  const blind = round === 1
  const lines = [frameBlock(frame, background), '', panelRules({ webSearch, searchBudget }), '', `Tahap: PANEL · Ronde ${round} (${blind ? 'blind' : 'kritik'})`]
  if (alias) lines.push(`Kamu adalah ${alias}.`)
  if (lens) lines.push(lensLine(lens))
  if (devilsAdvocate) lines.push(DEVILS_ADVOCATE)
  const registry = registryBlock(claims, aliasOf)
  if (blind) {
    lines.push('Ini ronde blind: jawab secara independen. Kamu belum melihat jawaban panelis lain.')
    lines.push(
      researched
        ? 'Mulai dari hasil riset dan lensamu: pilih temuan yang paling kuat, lalu turunkan idenya (temuan → kenapa belum dimanfaatkan → ide). Jangan mulai dari ide yang sudah umum lalu mencari pembenarannya.'
        : 'Mulai dari temuan yang tidak umum (cari dulu bila perlu), bukan dari ide yang sudah umum lalu mencari pembenarannya.'
    )
    // Di ronde 1 daftar klaim hanya berisi klaim dari memori sidang sebelumnya.
    if (registry) lines.push('', registry)
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
    '- Sumber literatur S (judul dan abstrak diambil program) boleh jadi dasar; rujuk mis. [S2]. Insight I adalah tafsiran peneliti, jadi sebut sumber S atau klaim K di baliknya.',
    '- Nilai kebaruan, bukan hanya kelayakan. Kalau draft condong ke jawaban klise tanpa pembeda yang didukung sumber, tulis itu di "disagreements" dan pilih ide yang berangkat dari temuan.',
    '- Jangan memaksakan kesepakatan dan jangan mengabaikan keberatan hanya karena datang dari minoritas. Tulis perbedaan pendapat apa adanya.',
    '- Tulis draft ringkas (usahakan maksimal sekitar 1.000 kata): utamakan keputusan, alasan, dan angka kunci, bukan pengulangan jawaban panelis.',
    '',
    'Format jawaban: satu objek JSON tanpa teks lain.',
    '{"summary": "ringkasan 1-3 kalimat", "agreements": ["..."], "disagreements": ["..."], "draft": "draft kesimpulan lengkap, boleh Markdown", "next_focus": "..."}'
  ].join('\n')
}

export function judgePrompt({ frame, background, round, previousDraft, responses, failed = [], claims = [], aliasOf }) {
  const lines = [frameBlock(frame, background), '', moderatorRules(), '', `Tahap: JUDGE · Ronde ${round}`]
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

export function votePrompt({ frame, background, draft, alias, previousVote, claims = [], aliasOf }) {
  const lines = [frameBlock(frame, background), '', voteRules(), '', 'Tahap: VOTE']
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
