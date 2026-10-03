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
      return { question: 'Ide hackathon apa yang paling layak?', criteria: ['bisa dibuat 48 jam', 'ada data masalahnya'], context: '' }
    case 'PANEL':
      return {
        position: `Posisi ${model} di ronde ${round}`,
        proposals: [{ id: 'P1', title: 'Aplikasi pencatat keuangan UMKM', why: 'banyak UMKM belum mencatat' }],
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
