// Membaca JSON dari jawaban agen lalu memvalidasi dan merapikannya.
// Model sering membungkus JSON dengan ```json atau menambah kalimat pembuka, jadi pembacaannya longgar;
// validasinya ketat hanya pada field yang wajib.

export const VOTES = ['AGREE', 'AGREE_WITH_RESERVATIONS', 'DISAGREE']
export const CLAIM_KINDS = ['fact', 'estimate', 'opinion']

export function extractJson(text) {
  const raw = String(text ?? '').trim()
  const candidates = [raw]
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(raw.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // coba kandidat berikutnya
    }
  }
  throw new Error('jawaban bukan objek JSON yang valid')
}

const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const list = (v) => (Array.isArray(v) ? v : [])
const strList = (v) => (typeof v === 'string' ? [v.trim()] : list(v).map(str)).filter(Boolean)

export function normalizeVote(vote) {
  if (!vote || typeof vote !== 'object') throw new Error('"vote" wajib berupa objek')
  const onDraft = str(vote.on_draft).toUpperCase().replace(/[\s-]+/g, '_')
  if (!VOTES.includes(onDraft)) throw new Error(`"vote.on_draft" harus salah satu dari ${VOTES.join(', ')}`)
  return {
    on_draft: onDraft,
    reservations: strList(vote.reservations),
    blocking_objections: strList(vote.blocking_objections)
  }
}

export function validateFrame(obj) {
  const question = str(obj.question)
  if (!question) throw new Error('"question" kosong')
  return { question, criteria: strList(obj.criteria), context: str(obj.context) }
}

export function validatePanelist(obj, { expectVote = false } = {}) {
  const position = str(obj.position)
  if (!position) throw new Error('"position" kosong')
  const proposals = list(obj.proposals)
    .map((p) => (typeof p === 'string' ? { title: p.trim(), why: '' } : { id: str(p?.id), title: str(p?.title), why: str(p?.why) }))
    .filter((p) => p.title)
    .map((p, i) => ({ id: p.id || `P${i + 1}`, title: p.title, why: p.why }))
  const claims = list(obj.claims)
    .map((c) => (typeof c === 'string' ? { text: c.trim() } : c || {}))
    .map((c) => {
      const kind = str(c.kind).toLowerCase()
      return { id: str(c.id), text: str(c.text), kind: CLAIM_KINDS.includes(kind) ? kind : 'opinion', source_url: str(c.source_url), quote: str(c.quote) }
    })
    .filter((c) => c.text)
    .map((c, i) => ({ ...c, id: c.id || `C${i + 1}` }))
  const critiques = list(obj.critiques)
    .map((c) => (typeof c === 'string' ? { target: '', point: c.trim(), severity: 'minor' } : { target: str(c?.target), point: str(c?.point), severity: str(c?.severity).toLowerCase() === 'blocking' ? 'blocking' : 'minor' }))
    .filter((c) => c.point)
  const cm = obj.changed_mind && typeof obj.changed_mind === 'object' ? obj.changed_mind : {}
  const result = {
    position,
    proposals,
    claims,
    critiques,
    changed_mind: { changed: cm.changed === true, what: str(cm.what), because: str(cm.because) }
  }
  if (expectVote) result.vote = normalizeVote(obj.vote)
  return result
}

export function validateJudge(obj) {
  const draft = str(obj.draft)
  if (!draft) throw new Error('"draft" kosong')
  return {
    summary: str(obj.summary) || draft.slice(0, 300),
    agreements: strList(obj.agreements),
    disagreements: strList(obj.disagreements),
    draft,
    next_focus: str(obj.next_focus)
  }
}

export function validateVoteOnly(obj) {
  return { vote: normalizeVote(obj.vote) }
}
