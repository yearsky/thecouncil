// Jawaban JSON yang masuk akal untuk tiap tahap sidang, dipakai agen palsu (CLI maupun API).
// Tahap dikenali dari baris "Tahap: ..." di prompt.
export function stageOf(input) {
  return input.match(/^Tahap: (\w+)/m)?.[1]
}

export function stageAnswer(stage, input, { model = 'fake', disagree = false, source = 'https://example.invalid/x' } = {}) {
  const round = Number(input.match(/Tahap: \w+ · Ronde (\d+)/)?.[1] || 0)
  const vote = { on_draft: disagree ? 'DISAGREE' : 'AGREE', reservations: [], blocking_objections: disagree ? ['belum ada data'] : [] }
  switch (stage) {
    case 'FRAME':
      return {
        question: 'Ide hackathon apa yang paling layak?',
        criteria: ['bisa dibuat 48 jam', 'ada data masalahnya', 'tidak klise'],
        context: '',
        obvious: ['chatbot WhatsApp untuk UMKM', 'pembukuan dari foto struk'],
        queries: ['smallholder credit scoring', 'kredit petani kecil']
      }
    case 'RESEARCH': {
      // Kutip abstrak sumber S1 kalau ada di prompt (paper palsu dari server literatur uji).
      const hasPaper = /^S1 · /m.test(input)
      return {
        insights: [
          { finding: 'Indeks vegetasi satelit memprediksi pembayaran kredit petani', sources: hasPaper ? ['S1'] : ['C1'], why_non_obvious: 'data bank tidak dipakai', implication: 'skor kredit tanpa riwayat', open_question: 'akurasi di Indonesia' },
          { finding: 'Versi Node yang stabil sudah tersedia', sources: ['C1'] }
        ],
        gaps: ['belum ada data panen per desa'],
        why_now: ['citra satelit gratis beresolusi tinggi'],
        claims: [
          { id: 'C1', text: 'Node.js 24 adalah LTS', kind: 'fact', source_url: source, quote: 'Node.js 24 adalah versi LTS' },
          ...(hasPaper ? [{ id: 'C2', text: 'Indeks vegetasi memprediksi pembayaran', kind: 'fact', source_url: 'S1', quote: 'satellite vegetation indices predict repayment' }] : [])
        ]
      }
    }
    case 'PANEL':
      return {
        position: `Posisi ${model} di ronde ${round}`,
        proposals: [{ id: 'P1', title: 'Skor kredit petani dari citra satelit', why: 'petani tanpa riwayat kredit', basis: ['I1'], non_obvious: 'bank belum memakai data satelit', why_now: 'citra gratis' }],
        claims: [{ id: 'C1', text: 'Node.js 24 adalah LTS', kind: 'fact', source_url: source, quote: 'Node.js 24 adalah versi LTS' }],
        ...(round > 1 ? { critiques: [], changed_mind: { changed: false }, vote } : {})
      }
    case 'JUDGE':
      return { summary: `Ringkasan ronde ${round}`, agreements: ['fokus UMKM'], disagreements: [], draft: `Draft kesimpulan ronde ${round}`, next_focus: 'data pendukung' }
    case 'VOTE':
      return { vote }
    default:
      return null
  }
}

export const fenced = (value) => 'Berikut jawabanku:\n```json\n' + JSON.stringify(value) + '\n```'
