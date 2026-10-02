// Menghitung suara. Keputusan berhenti diambil kode, bukan klaim model (docs/PLAN.md §4).

export const CONSENSUS_MODES = ['unanimous', 'majority']

// Setuju = AGREE atau AGREE_WITH_RESERVATIONS tanpa keberatan yang memblokir.
// Suara AGREE yang tetap mencantumkan keberatan pemblokir dianggap tidak setuju.
export function accepts(vote) {
  return Boolean(vote) && vote.on_draft !== 'DISAGREE' && vote.blocking_objections.length === 0
}

// Panelis yang gagal menjawab dihitung tidak setuju, supaya "bulat" berarti seluruh panel.
export function tally(panelIds, votesById) {
  const accepted = panelIds.filter((id) => accepts(votesById[id]))
  const total = panelIds.length
  const status = accepted.length === total ? 'unanimous' : accepted.length > total / 2 ? 'majority' : 'no_consensus'
  return { status, accepted, rejected: panelIds.filter((id) => !accepted.includes(id)), total }
}

export function isReached(status, mode) {
  return status === 'unanimous' || (mode === 'majority' && status === 'majority')
}
