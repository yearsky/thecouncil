// Halaman sidang: sidebar proses (stepper, panel, pemakaian) + tab Ringkasan / Riset / Debat / Klaim / Detail.
// Dirender ulang dari model run-state.js setiap ada event baru; pilihan pengguna (tab, ronde, kartu yang dibuka,
// filter klaim) disimpan di `view` supaya tidak hilang saat render ulang.

import { applyEvent, createRunState, debateRounds, searchesSoFar, stageOf, tokensSoFar } from './run-state.js'
import { FLAG, STATUS, VERIFY, VOTE, apiUrl, badge, el, md, num } from './ui.js'

const RESULT = {
  unanimous: { label: 'Disepakati bulat', tone: 'ok', icon: '✔' },
  majority: { label: 'Disepakati mayoritas', tone: 'warn', icon: '◐' },
  no_consensus: { label: 'Tidak ada konsensus', tone: 'bad', icon: '✖' },
  error: { label: 'Sidang gagal', tone: 'bad', icon: '✖' }
}

// Kelompok status verifikasi untuk filter dan ringkasan.
const CLAIM_GROUPS = [
  { key: 'verified', icon: '✅', label: 'Terverifikasi', match: (s) => s === 'verified' },
  { key: 'mismatch', icon: '⚠️', label: 'Kutipan tidak cocok', match: (s) => ['quote_partial', 'quote_not_found', 'no_quote'].includes(s) },
  { key: 'unverifiable', icon: '❔', label: 'Tidak bisa dicek', match: (s) => s === 'unverifiable' },
  { key: 'unreachable', icon: '❌', label: 'Sumber tidak ada', match: (s) => s === 'unreachable' },
  { key: 'no_source', icon: '➖', label: 'Tanpa sumber', match: (s) => s === 'no_source' },
  { key: 'pending', icon: '·', label: 'Belum dicek', match: (s) => !s }
]

const HOW_IT_WORKS = [
  ['Rumuskan pertanyaan', 'Moderator mengubah topikmu menjadi pertanyaan sidang, kriteria keberhasilan, dan daftar jawaban klise yang harus dilampaui.'],
  [
    'Riset literatur',
    'Program mencari paper di indeks ilmiah (Semantic Scholar, OpenAlex, arXiv). Peneliti AI membaca abstraknya, mencari laporan, regulasi, dan thesis di web, lalu menulis insight bersumber sebagai bahan berpikir panelis.'
  ],
  ['Ronde 1 · jawaban independen', 'Setiap panelis menjawab sendiri dengan lensa berpikir berbeda, tanpa melihat jawaban yang lain. Usulan wajib berangkat dari temuan, bukan dari ide yang sudah umum.'],
  ['Cek sumber', 'Program (bukan AI) membuka setiap URL yang dikutip dan mencari kutipannya. ✅ berarti kutipan memang ada di halaman itu.'],
  ['Rangkuman & ronde kritik', 'Moderator menyusun draft kesimpulan dari klaim ✅. Panelis lalu mengkritik draft dan jawaban panelis lain, dan memberi suara.'],
  ['Hasil', 'Sidang berhenti saat panelis sepakat. Kalau batas ronde habis, ada suara akhir dan hasilnya dilaporkan apa adanya.']
]

const SOURCE_LABEL = { semanticscholar: 'Semantic Scholar', openalex: 'OpenAlex', arxiv: 'arXiv' }

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

const groupOf = (claim) => CLAIM_GROUPS.find((g) => g.match(claim.verification?.status)) || CLAIM_GROUPS.at(-1)
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function createRunPage({ id, api, root }) {
  const state = createRunState()
  let run = null
  let error = null
  const desktop = typeof matchMedia === 'function' && matchMedia('(min-width: 960px)').matches
  const view = { tab: 'ringkasan', round: null, roundPinned: false, expanded: new Set(), claimFilter: 'all', stepperOpen: desktop, howOpen: false }

  const side = el('aside', { class: 'run-side', 'aria-label': 'Proses sidang' })
  const head = el('header', { class: 'run-head' })
  const tabs = el('div', { class: 'tabs', role: 'tablist' })
  const panel = el('div', { class: 'run-panel', role: 'tabpanel' })
  root.replaceChildren(el('div', { class: 'run-layout' }, side, el('div', { class: 'run-main' }, head, tabs, panel)))

  const name = (agent) => state.labels[agent] || agent
  const panelist = (agentId) => state.panel.find((p) => p.id === agentId)

  // Jam berjalan: hanya teks elemen [data-since] yang diperbarui tiap detik, tanpa render ulang.
  const ticker = setInterval(() => {
    for (const node of root.querySelectorAll('[data-since]')) node.textContent = duration(Date.now() - Date.parse(node.dataset.since))
  }, 1000)
  const since = (iso, cls = 'clock') => (iso ? el('span', { class: cls, 'data-since': iso }, duration(Date.now() - Date.parse(iso))) : null)

  // ---------- sidebar ----------

  function statusBadge(stage) {
    if (stage.kind === 'finished') return badge(STATUS[state.finished.status] || [state.finished.status])
    if (stage.kind === 'paused') return badge(['dijeda · lanjut saat dibuka', 'warn'])
    if (stage.kind === 'cancelled') return badge(STATUS.cancelled)
    if (stage.kind === 'error') return badge(STATUS.error)
    return badge(['berjalan', 'info'])
  }

  function renderSide(stage) {
    const steps = stage.steps
    const visible = steps.filter((s) => s.status !== 'skipped' || s.key === 'vote' || s.key.startsWith('judge'))
    const position = Math.max(0, steps.findIndex((s) => s.status === 'active')) + 1
    const doneCount = steps.filter((s) => s.status === 'done').length
    const ended = ['finished', 'cancelled', 'error'].includes(stage.kind)
    const endTs = state.finished?.ts || state.cancelled?.ts
    const elapsed = state.startedAt
      ? ended && endTs
        ? el('span', { class: 'clock' }, duration(Date.parse(endTs) - Date.parse(state.startedAt)))
        : since(state.startedAt)
      : null

    const stepper = el(
      'ol',
      { class: 'stepper' },
      visible.map((s) =>
        el(
          'li',
          { class: `step ${s.status}` },
          el('span', { class: 'dot', 'aria-hidden': 'true' }, s.status === 'done' ? '✓' : ''),
          el(
            'div',
            { class: 'step-body' },
            el('span', { class: 'step-title' }, s.title, s.status === 'skipped' ? el('span', { class: 'muted' }, ' · dilewati') : null),
            s.status === 'active'
              ? el(
                  'div',
                  { class: 'step-detail' },
                  s.detail,
                  s.progress ? el('div', { class: 'progress' }, el('span', { style: `width:${(100 * s.progress.done) / Math.max(1, s.progress.total)}%` })) : null,
                  s.progress ? el('span', { class: 'muted' }, `${s.progress.done} dari ${s.progress.total} panelis selesai`) : null,
                  s.note ? el('span', { class: 'muted step-note' }, s.note) : null
                )
              : null
          )
        )
      )
    )
    const box = el(
      'details',
      { class: 'stepper-box', open: view.stepperOpen, ontoggle: (ev) => (view.stepperOpen = ev.target.open) },
      el(
        'summary',
        {},
        el('span', { class: 'kicker' }, ended ? `Proses · ${doneCount} tahap` : `Tahap ${position} dari ${steps.filter((s) => s.status !== 'skipped').length}`),
        el('span', { class: 'summary-title' }, stage.title)
      ),
      stepper
    )

    // Status panelis, pemakaian, dan penjelasan. Di HP ketiganya masuk ke dalam stepper yang bisa dibuka,
    // supaya bar proses di atas tetap ringkas; di desktop tampil di sidebar.
    const extras = () => [peopleBlock(), statsBlock(), howBlock()]
    box.append(el('div', { class: 'mobile-only' }, extras()))

    const cancel =
      run?.status === 'running'
        ? el(
            'button',
            {
              type: 'button',
              class: 'secondary small-button',
              onclick: async (ev) => {
                if (!confirm('Batalkan sidang ini? Panggilan yang sedang berjalan tetap diselesaikan dulu.')) return
                ev.target.disabled = true
                await api(`runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch((err) => alert(err.message))
              }
            },
            'Batalkan'
          )
        : null

    side.replaceChildren(
      el(
        'div',
        { class: 'side-card' },
        el('div', { class: 'side-top' }, statusBadge(stage), elapsed ? el('span', { class: 'muted' }, ended ? 'durasi ' : '', elapsed) : null, cancel),
        box,
        el('div', { class: 'desktop-only' }, extras())
      )
    )
  }

  function peopleBlock() {
    const rounds = [...state.rounds.values()].sort((a, b) => a.round - b.round)
    const current = rounds.at(-1)
    return el(
      'div',
      { class: 'side-block' },
      el('h3', {}, current ? (current.mode === 'vote' ? 'Panel · suara akhir' : `Panel · ronde ${current.round}`) : 'Panel'),
      state.panel.map((p) => {
        const a = current?.agents[p.id]
        const st = !a ? ['menunggu', ''] : a.status === 'running' ? ['menjawab', 'info'] : a.status === 'failed' ? ['gagal', 'bad'] : ['selesai', 'ok']
        return el(
          'div',
          { class: 'person' },
          el('span', { class: 'avatar', 'aria-hidden': 'true' }, (p.alias || p.label).replace('Panelis ', '').slice(0, 1)),
          el('div', { class: 'person-body' }, el('strong', {}, p.alias || p.label, p.lens ? el('span', { class: 'lens' }, p.lens) : null), el('span', { class: 'muted' }, `${p.label}${p.model ? ` · ${p.model}` : ''}`)),
          el('span', { class: `chip ${st[1]}` }, st[0], a?.status === 'running' ? [' ', since(a.startedAt, 'clock small')] : null)
        )
      }),
      state.moderator ? el('p', { class: 'muted small' }, `Moderator: ${state.moderator.label}${state.moderator.model ? ` · ${state.moderator.model}` : ''}`) : null
    )
  }

  function statsBlock() {
    const t = tokensSoFar(state)
    const counts = claimCounts()
    return el(
      'div',
      { class: 'side-block stats' },
      el('div', {}, el('span', { class: 'muted' }, 'Token masuk'), el('strong', {}, num(t.input + t.cacheRead + t.cacheWrite))),
      el('div', {}, el('span', { class: 'muted' }, 'Token keluar'), el('strong', {}, num(t.output))),
      el('div', {}, el('span', { class: 'muted' }, 'Klaim ✅'), el('strong', {}, `${counts.verified || 0} / ${state.claims.size}`)),
      searchStat(),
      t.complete ? null : el('p', { class: 'muted small' }, 'Token moderator baru dihitung di akhir sidang.')
    )
  }

  // Jumlah pencarian web yang dilaporkan penyedia. Menjawab "apakah AI benar-benar mencari?".
  function searchStat() {
    const s = searchesSoFar(state)
    if (!s) return null
    return el(
      'div',
      { title: s.withoutSearch ? `${s.withoutSearch} jawaban tanpa satu pun pencarian` : 'Semua jawaban dengan web search memakai pencarian' },
      el('span', { class: 'muted' }, 'Pencarian web'),
      el('strong', {}, `${s.requests}${s.withoutSearch ? ` · ${s.withoutSearch} tanpa` : ''}`)
    )
  }

  function howBlock() {
    return el(
      'details',
      { class: 'howto', open: view.howOpen, ontoggle: (ev) => (view.howOpen = ev.target.open) },
      el('summary', {}, 'Cara kerja sidang'),
      el('ol', {}, HOW_IT_WORKS.map(([title, text]) => el('li', {}, el('strong', {}, title), el('span', {}, text))))
    )
  }

  // ---------- kepala & tab ----------

  function renderHead() {
    const parts = [
      el('h1', { class: 'run-title', title: state.topic || run?.topic || '' }, state.topic || run?.topic || 'Memuat sidang…'),
      state.frame ? el('p', { class: 'run-question' }, el('span', { class: 'kicker' }, 'Pertanyaan sidang'), state.frame.question) : null,
      error ? el('p', { class: 'error' }, error) : null
    ]
    head.replaceChildren(...parts.filter(Boolean))
  }

  function claimCounts() {
    const counts = {}
    for (const c of state.claims.values()) {
      const g = groupOf(c).key
      counts[g] = (counts[g] || 0) + 1
    }
    return counts
  }

  function renderTabs() {
    const showResearch = state.researchEnabled || state.literature || state.research || state.frame?.obvious?.length
    const items = [
      ['ringkasan', state.finished ? 'Hasil' : 'Ringkasan'],
      showResearch ? ['riset', 'Riset', state.research?.insights.length] : null,
      ['debat', 'Debat', debateRounds(state).length || null],
      ['klaim', 'Klaim', state.claims.size],
      ['detail', 'Detail']
    ]
    if (view.tab === 'riset' && !showResearch) view.tab = 'ringkasan'
    tabs.replaceChildren(
      ...items.filter(Boolean).map(([key, label, count]) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `tab${view.tab === key ? ' active' : ''}`,
            'aria-selected': view.tab === key ? 'true' : 'false',
            onclick: () => {
              view.tab = key
              render()
            }
          },
          label,
          count != null ? el('span', { class: 'tab-count' }, String(count)) : null
        )
      )
    )
  }

  // ---------- tab Ringkasan / Hasil ----------

  function votesTable(votes) {
    if (!votes) return null
    return el(
      'div',
      { class: 'vote-list' },
      state.panel.map((p) => {
        const v = votes.votes?.[p.id]
        return el(
          'div',
          { class: 'vote-row' },
          el('div', { class: 'vote-who' }, el('strong', {}, p.alias || p.label), el('span', { class: 'muted' }, p.label)),
          v ? badge(VOTE[v.on_draft] || [v.on_draft]) : badge(['gagal menjawab', 'bad']),
          v && (v.blocking_objections?.length || v.reservations?.length || v.change_reason)
            ? el(
                'ul',
                { class: 'vote-notes' },
                (v.blocking_objections || []).map((o) => el('li', {}, el('strong', {}, 'Keberatan: '), o)),
                (v.reservations || []).map((o) => el('li', {}, 'Catatan: ', o)),
                v.change_reason ? el('li', {}, 'Alasan berubah: ', v.change_reason) : null
              )
            : null
        )
      })
    )
  }

  function points(title, list, tone) {
    if (!list?.length) return null
    return el('div', { class: `points ${tone}` }, el('h3', {}, title), el('ul', {}, list.map((x) => el('li', {}, x))))
  }

  function resultCard() {
    const f = state.finished
    const r = RESULT[f.status] || { label: f.status, tone: '', icon: '' }
    const decided = state.rounds.get(f.round)?.votes
    const judged = decided ? state.rounds.get(decided.draftRound)?.judged : [...state.rounds.values()].map((x) => x.judged).filter(Boolean).at(-1)
    const how = f.decidedBy === 'vote' ? 'lewat suara akhir' : f.decidedBy === 'critique' ? `di ronde ${f.round}` : ''
    const counts = claimCounts()
    return el(
      'section',
      { class: `result-card ${r.tone}` },
      el(
        'div',
        { class: 'result-head' },
        el('span', { class: 'result-icon', 'aria-hidden': 'true' }, r.icon),
        el('div', {}, el('span', { class: 'kicker' }, 'Hasil sidang'), el('h2', {}, r.label), el('span', { class: 'muted' }, [how, decided ? `${decided.accepted.length} dari ${decided.total} panelis setuju` : ''].filter(Boolean).join(' · ')))
      ),
      f.summary ? el('p', { class: 'result-summary' }, f.summary) : null,
      f.status !== 'unanimous' && f.draft ? el('p', { class: 'note warn' }, 'Kesimpulan ini tidak disetujui bulat. Lihat suara dan perbedaan pendapat di bawah.') : null,
      f.draft ? el('div', { class: 'result-body' }, md(f.draft)) : el('p', { class: 'muted' }, 'Sidang tidak menghasilkan kesimpulan.'),
      el('div', { class: 'grid-2' }, points('Disepakati', judged?.agreements, 'ok'), points('Masih diperdebatkan', judged?.disagreements, 'warn')),
      decided ? el('div', { class: 'block' }, el('h3', {}, `Suara atas draft ronde ${decided.draftRound}`), votesTable(decided)) : null,
      el(
        'p',
        { class: 'muted small' },
        `Klaim: ${CLAIM_GROUPS.filter((g) => counts[g.key]).map((g) => `${g.icon} ${counts[g.key]}`).join(' · ') || 'tidak ada'} — `,
        el('a', { href: '#', onclick: (ev) => (ev.preventDefault(), (view.tab = 'klaim'), render()) }, 'lihat semua klaim')
      ),
      el(
        'div',
        { class: 'actions' },
        el('a', { class: 'button secondary', href: apiUrl(`runs/${id}/report`), download: `${id}.md` }, 'Unduh laporan (.md)'),
        el('a', { class: 'button', href: `#/baru?lanjut=${encodeURIComponent(id)}` }, 'Lanjutkan sidang ini')
      )
    )
  }

  function liveCard(stage) {
    const step = stage.step
    const r = step?.round ? state.rounds.get(step.round) : null
    const running = r ? Object.entries(r.agents).filter(([, a]) => a.status === 'running') : []
    return el(
      'section',
      { class: `live-card ${stage.kind}` },
      el('span', { class: 'kicker' }, stage.kind === 'paused' ? 'Dijeda' : stage.kind === 'running' ? 'Sedang berlangsung' : 'Status'),
      el('h2', {}, stage.title),
      el('p', {}, stage.detail),
      step?.note ? el('p', { class: 'muted small' }, step.note) : null,
      stage.kind === 'paused' ? el('p', { class: 'muted small' }, 'Sidang dilanjutkan otomatis selama halaman ini terbuka.') : null,
      running.length
        ? el(
            'div',
            { class: 'chips' },
            running.map(([agent, a]) => el('span', { class: 'chip info' }, `${name(agent)} menjawab · `, since(a.startedAt, 'clock small')))
          )
        : null
    )
  }

  function renderSummary(stage) {
    const nodes = []
    if (state.finished) nodes.push(resultCard())
    else nodes.push(liveCard(stage))

    if (!state.finished) {
      const judgedRounds = [...state.rounds.values()].filter((x) => x.judged).sort((a, b) => a.round - b.round)
      const last = judgedRounds.at(-1)
      if (last) {
        nodes.push(
          el(
            'section',
            { class: 'card' },
            el('span', { class: 'kicker' }, `Draft sementara · ronde ${last.round}`),
            el('p', {}, last.judged.summary),
            el('div', { class: 'grid-2' }, points('Disepakati', last.judged.agreements, 'ok'), points('Masih diperdebatkan', last.judged.disagreements, 'warn')),
            el('details', {}, el('summary', {}, 'Baca draft kesimpulan'), md(last.judged.draft))
          )
        )
      }
      const lastVotes = [...state.rounds.values()].filter((x) => x.votes).sort((a, b) => a.round - b.round).at(-1)
      if (lastVotes) nodes.push(el('section', { class: 'card' }, el('span', { class: 'kicker' }, `Suara terakhir · ronde ${lastVotes.round}`), votesTable(lastVotes.votes)))
    }

    if (state.research?.insights.length) {
      nodes.push(
        el(
          'section',
          { class: 'card' },
          el('span', { class: 'kicker' }, `Bahan riset · ${state.research.insights.length} insight dari ${state.literature?.papers.length || 0} sumber ilmiah`),
          el('ul', { class: 'compact' }, state.research.insights.slice(0, 3).map((x) => el('li', {}, el('strong', {}, `${x.id} `), x.finding))),
          el('a', { href: '#', onclick: (ev) => (ev.preventDefault(), (view.tab = 'riset'), render()) }, 'Lihat semua insight dan sumber')
        )
      )
    }
    if (state.frame) {
      nodes.push(
        el(
          'section',
          { class: 'card' },
          el('span', { class: 'kicker' }, 'Kriteria keberhasilan'),
          state.frame.criteria.length ? el('ul', {}, state.frame.criteria.map((c) => el('li', {}, c))) : el('p', { class: 'muted' }, 'Tidak ada kriteria khusus.'),
          state.frame.context ? el('p', { class: 'muted small' }, `Konteks: ${state.frame.context}`) : null
        )
      )
    }
    if (state.warnings.length) nodes.push(el('section', { class: 'card warn-card' }, el('span', { class: 'kicker' }, 'Peringatan'), el('ul', {}, state.warnings.map((w) => el('li', {}, w.message)))))
    return nodes
  }

  // ---------- tab Debat ----------

  function agentCard(r, p) {
    const a = r.agents[p.id]
    const key = `${r.round}:${p.id}`
    const open = view.expanded.has(key)
    const toggle = () => {
      if (open) view.expanded.delete(key)
      else view.expanded.add(key)
      render()
    }
    const headLine = el(
      'header',
      {},
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, (p.alias || p.label).replace('Panelis ', '').slice(0, 1)),
      el(
        'div',
        { class: 'person-body' },
        el('strong', {}, p.alias || p.label, p.lens ? el('span', { class: 'lens', title: 'Lensa berpikir panelis ini' }, p.lens) : null),
        el('span', { class: 'muted' }, `${p.label}${p.model ? ` · ${p.model}` : ''}`)
      ),
      r.devil === p.id ? el('span', { class: 'chip warn', title: "Devil's advocate: wajib mencari kelemahan draft" }, 'devil’s advocate') : null
    )
    if (!a) return el('article', { class: 'agent-card waiting-card' }, headLine, el('p', { class: 'muted' }, 'Menunggu giliran.'))
    if (a.status === 'running') return el('article', { class: 'agent-card running' }, headLine, el('div', { class: 'skeleton' }, el('span'), el('span'), el('span')), el('p', { class: 'muted small' }, 'Sedang menjawab · ', since(a.startedAt, 'clock small')))
    if (a.status === 'failed') return el('article', { class: 'agent-card failed' }, headLine, el('p', {}, badge(['gagal', 'bad'])), el('code', { class: 'error-text' }, a.error))

    const x = a.response || {}
    const ids = [...new Set([...(x.claims || []).map((c) => c.id), ...(x.cited_claims || [])])].filter(Boolean)
    const proposals = x.proposals || []
    const tokens = a.usage?.tokens
    return el(
      'article',
      { class: `agent-card done${open ? ' open' : ''}` },
      headLine,
      x.vote ? el('div', { class: 'vote-line' }, badge(VOTE[x.vote.on_draft] || [x.vote.on_draft])) : null,
      x.position ? el('p', { class: `position${open ? '' : ' clamp'}` }, x.position) : null,
      proposals.length
        ? el(
            'ul',
            { class: 'proposals' },
            (open ? proposals : proposals.slice(0, 2)).map((pr) =>
              el(
                'li',
                {},
                el('strong', {}, pr.title),
                pr.basis?.length ? el('span', { class: 'basis' }, pr.basis.map((ref) => refChip(ref))) : null,
                open && pr.why ? el('span', { class: 'muted' }, ` — ${pr.why}`) : null,
                open && pr.non_obvious ? el('span', { class: 'sub' }, el('em', {}, 'Tidak umum karena: '), pr.non_obvious) : null,
                open && pr.why_now ? el('span', { class: 'sub' }, el('em', {}, 'Kenapa sekarang: '), pr.why_now) : null
              )
            )
          )
        : null,
      ids.length
        ? el(
            'div',
            { class: 'chips' },
            ids.map((cid) => {
              const c = state.claims.get(cid)
              return el('span', { class: 'chip', title: c?.text || cid }, `${cid} ${c ? groupOf(c).icon : '·'}`)
            })
          )
        : null,
      open && x.critiques?.length ? el('div', { class: 'block' }, el('h4', {}, 'Kritik'), el('ul', {}, x.critiques.map((c) => el('li', {}, el('span', { class: `chip ${c.severity === 'blocking' ? 'bad' : ''}` }, c.severity), ` ${c.target ? `${c.target}: ` : ''}${c.point}`)))) : null,
      open && x.changed_mind?.changed ? el('p', { class: 'note' }, `Berubah pendapat: ${x.changed_mind.what} (karena: ${x.changed_mind.because || 'tidak disebutkan'})`) : null,
      open && x.vote?.blocking_objections?.length ? el('ul', { class: 'vote-notes' }, x.vote.blocking_objections.map((o) => el('li', {}, el('strong', {}, 'Keberatan: '), o))) : null,
      open && x.vote?.reservations?.length ? el('ul', { class: 'vote-notes' }, x.vote.reservations.map((o) => el('li', {}, 'Catatan: ', o))) : null,
      open && a.search?.urls?.length ? searchList(a.search) : null,
      el(
        'footer',
        {},
        el(
          'span',
          { class: 'muted small' },
          [a.ms !== undefined ? duration(a.ms) : null, a.search ? searchText(a.search) : null, tokens ? `${num(tokens.input + tokens.cacheRead + tokens.cacheWrite)} → ${num(tokens.output)} token` : null, a.repaired ? 'format diperbaiki' : null]
            .filter(Boolean)
            .join(' · ')
        ),
        el('button', { type: 'button', class: 'link', onclick: toggle }, open ? 'Ringkas' : 'Selengkapnya')
      )
    )
  }

  const searchText = (s) => (s.requests ? `🔎 ${s.requests} pencarian` : '🔎 tidak mencari')
  const searchList = (s) =>
    el(
      'details',
      { class: 'search-list' },
      el('summary', {}, `Halaman dari pencarian (${s.results})`),
      el('ul', {}, s.urls.map((u) => el('li', {}, el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, host(u)))))
    )

  // Chip rujukan: S (sumber literatur), I (insight), K (klaim, dengan status verifikasinya).
  function refChip(ref) {
    const paper = state.literature?.papers.find((p) => p.id === ref)
    if (paper) return el('a', { class: 'chip ref', href: paper.url, target: '_blank', rel: 'noopener noreferrer', title: paper.title }, ref)
    const insight = state.research?.insights.find((x) => x.id === ref)
    if (insight) return el('button', { type: 'button', class: 'chip ref', title: insight.finding, onclick: () => ((view.tab = 'riset'), render()) }, ref)
    const claim = state.claims.get(ref)
    if (claim) return el('span', { class: 'chip ref', title: claim.text }, `${ref} ${groupOf(claim).icon}`)
    return el('span', { class: 'chip ref' }, ref)
  }

  // ---------- tab Riset ----------

  function renderResearch() {
    const nodes = []
    const lit = state.literature
    const res = state.research
    if (state.frame?.obvious?.length) {
      nodes.push(
        el(
          'section',
          { class: 'card cliche-card' },
          el('span', { class: 'kicker' }, 'Jawaban klise yang harus dilampaui'),
          el('p', { class: 'muted small' }, 'Disusun moderator sebelum debat. Usulan yang sama dengan daftar ini harus punya pembeda yang didukung sumber.'),
          el('ul', { class: 'chips' }, state.frame.obvious.map((o) => el('li', { class: 'chip strike' }, o)))
        )
      )
    }
    if (!res && !lit) {
      nodes.push(el('section', { class: 'card' }, el('p', { class: 'muted' }, state.researchEnabled ? 'Riset dimulai setelah pertanyaan sidang dirumuskan.' : 'Riset literatur dimatikan untuk sidang ini.')))
      return nodes
    }
    if (res) {
      const meta = [res.ms !== undefined ? duration(res.ms) : null, res.search ? searchText(res.search) : null, state.researchVerified ? `${state.researchVerified.total} klaim dicek` : null].filter(Boolean).join(' · ')
      nodes.push(
        el(
          'section',
          { class: 'card' },
          el('span', { class: 'kicker' }, `Insight peneliti · ${res.insights.length}`),
          el('p', { class: 'muted small' }, 'Insight adalah tafsiran AI; buktinya ada di sumber S dan klaim K yang dirujuk. ', meta),
          el(
            'div',
            { class: 'insight-list' },
            res.insights.map((x) =>
              el(
                'article',
                { class: 'insight' },
                el('header', {}, el('strong', {}, x.id), el('span', { class: 'basis' }, x.sources.length ? x.sources.map(refChip) : el('span', { class: 'chip warn' }, 'tanpa sumber'))),
                el('p', {}, x.finding),
                x.why_non_obvious ? el('p', { class: 'sub' }, el('em', {}, 'Tidak umum karena: '), x.why_non_obvious) : null,
                x.implication ? el('p', { class: 'sub' }, el('em', {}, 'Implikasi: '), x.implication) : null,
                x.open_question ? el('p', { class: 'sub muted' }, el('em', {}, 'Belum pasti: '), x.open_question) : null
              )
            )
          ),
          res.search?.urls?.length ? searchList(res.search) : null
        )
      )
      if (res.gaps.length || res.why_now.length) nodes.push(el('section', { class: 'card' }, el('div', { class: 'grid-2' }, points('Masalah yang belum terpecahkan', res.gaps, 'warn'), points('Yang baru berubah (why now)', res.why_now, 'ok'))))
    } else if (lit) {
      nodes.push(el('section', { class: 'card live-card running' }, el('span', { class: 'kicker' }, 'Sedang berlangsung'), el('h2', {}, 'Peneliti sedang membaca'), el('p', {}, `${lit.papers.length} sumber ilmiah ditemukan. Peneliti membaca abstraknya dan mencari laporan, regulasi, dan thesis di web.`)))
    }
    if (lit) {
      const sources = Object.entries(lit.stats || {})
        .map(([k, v]) => `${SOURCE_LABEL[k] || k}: ${v.results} hasil`)
        .join(' · ')
      nodes.push(
        el(
          'section',
          { class: 'card' },
          el('span', { class: 'kicker' }, `Sumber literatur · ${lit.papers.length}`),
          el('p', { class: 'muted small' }, 'Judul dan abstrak diambil program dari indeks ilmiah, bukan ditulis AI. Kutipan dari abstrak dicek langsung ke teks ini.', sources ? ` (${sources})` : ''),
          lit.queries.length ? el('p', { class: 'small' }, el('span', { class: 'muted' }, 'Kata kunci: '), lit.queries.join(' · ')) : null,
          lit.papers.length
            ? el(
                'ol',
                { class: 'paper-list' },
                lit.papers.map((p) =>
                  el(
                    'li',
                    { class: 'paper' },
                    el('div', {}, el('span', { class: 'chip ref' }, p.id), ' ', p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.title) : p.title),
                    el('span', { class: 'muted small' }, [p.year, p.venue, p.citations != null ? `${p.citations} sitasi` : null, p.authors?.length ? `${p.authors[0]}${p.authors.length > 1 ? ' dkk.' : ''}` : null].filter(Boolean).join(' · ')),
                    p.abstract || p.tldr ? el('details', {}, el('summary', {}, 'Abstrak'), el('p', { class: 'small' }, p.abstract || p.tldr)) : null
                  )
                )
              )
            : el('p', { class: 'muted' }, 'Tidak ada sumber ilmiah yang ditemukan; peneliti hanya memakai pencarian web.'),
          lit.errors?.length ? el('p', { class: 'note warn' }, `Sebagian pencarian gagal: ${[...new Set(lit.errors.map((e) => `${e.source} (${e.message})`))].join('; ')}`) : null
        )
      )
    }
    return nodes
  }

  function renderDebate() {
    const rounds = [...state.rounds.values()].sort((a, b) => a.round - b.round)
    if (!rounds.length) return [el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Ronde pertama belum dimulai.'))]
    if (!view.roundPinned || !state.rounds.has(view.round)) view.round = rounds.at(-1).round
    const r = state.rounds.get(view.round)
    const label = (x) => (x.mode === 'vote' ? 'Suara akhir' : `Ronde ${x.round}`)
    const nodes = [
      el(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Pilih ronde' },
        rounds.map((x) =>
          el(
            'button',
            {
              type: 'button',
              class: x.round === view.round ? 'active' : '',
              'aria-pressed': x.round === view.round ? 'true' : 'false',
              onclick: () => {
                view.round = x.round
                view.roundPinned = x.round !== rounds.at(-1).round
                render()
              }
            },
            label(x)
          )
        )
      ),
      el(
        'p',
        { class: 'round-intro muted' },
        r.mode === 'blind' ? 'Ronde blind: panelis menjawab tanpa melihat jawaban yang lain.' : r.mode === 'vote' ? 'Suara akhir atas draft moderator terakhir.' : 'Ronde kritik: panelis mengkritik draft dan jawaban lain, lalu memberi suara.',
        r.devil ? ` Devil's advocate: ${name(r.devil)}.` : ''
      ),
      el('div', { class: 'agent-grid' }, state.panel.map((p) => agentCard(r, p)))
    ]
    if (r.verified) {
      const counts = Object.entries(r.verified.counts || {}).map(([s, n]) => `${VERIFY[s]?.[0] || s} ${n}`)
      nodes.push(el('p', { class: 'muted small' }, `Cek sumber oleh program: ${r.verified.total} klaim baru · ${counts.join(' · ')}`))
    }
    const roundFlags = state.flags.filter((f) => f.round === r.round)
    if (roundFlags.length) nodes.push(el('div', { class: 'card warn-card' }, el('span', { class: 'kicker' }, 'Catatan integritas'), el('ul', {}, roundFlags.map((f) => el('li', {}, `${name(f.agent)} ${FLAG[f.type] || f.type}${f.detail ? ` (${f.detail})` : ''}`)))))
    if (r.votes) nodes.push(el('section', { class: 'card' }, el('span', { class: 'kicker' }, `Suara atas draft ronde ${r.votes.draftRound}`), el('p', {}, `${r.votes.accepted.length} dari ${r.votes.total} setuju `, badge(STATUS[r.votes.status] || [r.votes.status])), votesTable(r.votes)))
    if (r.judged) {
      nodes.push(
        el(
          'section',
          { class: 'card moderator-card' },
          el('span', { class: 'kicker' }, `Moderator · rangkuman ronde ${r.round}`),
          el('p', {}, r.judged.summary),
          el('div', { class: 'grid-2' }, points('Disepakati', r.judged.agreements, 'ok'), points('Masih diperdebatkan', r.judged.disagreements, 'warn')),
          el('details', {}, el('summary', {}, 'Draft kesimpulan ronde ini'), md(r.judged.draft)),
          r.judged.next_focus ? el('p', { class: 'muted small' }, `Fokus berikutnya: ${r.judged.next_focus}`) : null
        )
      )
    }
    return nodes
  }

  // ---------- tab Klaim ----------

  function renderClaims() {
    const claims = [...state.claims.values()]
    if (!claims.length) return [el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Belum ada klaim. Klaim muncul setelah panelis menjawab ronde pertama.'))]
    const counts = claimCounts()
    const filters = [['all', `Semua · ${claims.length}`], ...CLAIM_GROUPS.filter((g) => counts[g.key]).map((g) => [g.key, `${g.icon} ${g.label} · ${counts[g.key]}`])]
    if (!filters.some(([k]) => k === view.claimFilter)) view.claimFilter = 'all'
    const shown = claims.filter((c) => view.claimFilter === 'all' || groupOf(c).key === view.claimFilter)
    return [
      el('p', { class: 'muted small' }, 'Status dicek oleh program: halaman sumber dibuka dan kutipannya dicari (untuk sumber literatur, dicari di abstraknya). ❔ berarti situsnya tidak bisa dibuka otomatis, bukan berarti salah.'),
      el(
        'div',
        { class: 'segmented wrap', role: 'group', 'aria-label': 'Saring klaim' },
        filters.map(([key, label]) =>
          el(
            'button',
            {
              type: 'button',
              class: view.claimFilter === key ? 'active' : '',
              'aria-pressed': view.claimFilter === key ? 'true' : 'false',
              onclick: () => {
                view.claimFilter = key
                render()
              }
            },
            label
          )
        )
      ),
      el(
        'div',
        { class: 'claim-list' },
        shown.map((c) => {
          const g = groupOf(c)
          return el(
            'article',
            { class: `claim ${g.key}` },
            el('header', {}, el('strong', {}, c.id), el('span', { class: 'chip' }, `${g.icon} ${c.verification?.detail || g.label}`), el('span', { class: 'chip' }, c.kind), c.source ? refChip(c.source) : null),
            el('p', {}, c.text),
            c.source_url ? el('p', { class: 'small' }, el('a', { href: c.source_url, target: '_blank', rel: 'noopener noreferrer' }, host(c.source_url)), c.quote ? el('span', { class: 'muted' }, ` — "${c.quote}"`) : null) : null,
            el('p', { class: 'muted small' }, `oleh ${[...(c.by || [])].map(name).join(', ')}`)
          )
        })
      )
    ]
  }

  // ---------- tab Detail ----------

  function renderDetail() {
    const u = state.finished?.usage
    const rows = [
      ['Panel', state.panel.map((p) => `${p.alias ? `${p.alias} = ` : ''}${p.label}${p.model ? ` (${p.model})` : ''}${p.lens ? ` · lensa ${p.lens}` : ''}`).join(', ')],
      ['Moderator', state.moderator ? `${state.moderator.label}${state.moderator.model ? ` (${state.moderator.model})` : ''}` : '–'],
      ['Ronde maks.', String(state.maxRounds || '–')],
      ['Konsensus', state.consensus === 'majority' ? 'mayoritas' : 'bulat'],
      ['Web search', state.web ? 'aktif' : 'mati'],
      ['Verifikasi sumber', state.verify ? 'aktif (oleh program)' : 'mati'],
      ['Riset literatur', state.researchEnabled ? 'aktif' : 'mati'],
      ['Melanjutkan', state.memory.length ? state.memory.map((m) => m.question).join('; ') : '–']
    ]
    return [
      el('section', { class: 'card' }, el('span', { class: 'kicker' }, 'Topik lengkap'), el('div', { class: 'topic-full' }, state.topic || run?.topic || '')),
      el('section', { class: 'card' }, el('span', { class: 'kicker' }, 'Pengaturan'), el('dl', { class: 'facts' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))),
      state.flags.length ? el('section', { class: 'card warn-card' }, el('span', { class: 'kicker' }, 'Catatan integritas'), el('ul', {}, state.flags.map((f) => el('li', {}, `Ronde ${f.round}: ${name(f.agent)} ${FLAG[f.type] || f.type}${f.detail ? ` (${f.detail})` : ''}`)))) : null,
      state.warnings.length ? el('section', { class: 'card warn-card' }, el('span', { class: 'kicker' }, 'Peringatan'), el('ul', {}, state.warnings.map((w) => el('li', {}, w.message)))) : null,
      u
        ? el(
            'section',
            { class: 'card' },
            el('span', { class: 'kicker' }, 'Pemakaian'),
            el('p', {}, `${u.calls} panggilan AI${u.failedCalls ? ` (${u.failedCalls} gagal)` : ''}${u.searches ? ` · ${u.searches} pencarian web` : ''}${u.costUsd ? ` · estimasi $${u.costUsd.toFixed(4)}` : ''}${u.truncated ? ` · ⚠️ ${u.truncated} jawaban kena batas maxTokens` : ''}`),
            el(
              'div',
              { class: 'table-wrap' },
              el(
                'table',
                {},
                el('thead', {}, el('tr', {}, ['Peran', 'Panggilan', 'Token masuk', 'dari cache', 'Token keluar'].map((h) => el('th', {}, h)))),
                el(
                  'tbody',
                  {},
                  Object.entries(u.byRole || {}).map(([role, b]) =>
                    el(
                      'tr',
                      {},
                      el('td', {}, role === 'moderator' ? 'Moderator' : name(role)),
                      el('td', {}, String(b.calls)),
                      el('td', {}, num(b.tokens.input + b.tokens.cacheRead + b.tokens.cacheWrite)),
                      el('td', {}, num(b.tokens.cacheRead)),
                      el('td', {}, num(b.tokens.output))
                    )
                  )
                )
              )
            )
          )
        : el('section', { class: 'card' }, el('span', { class: 'kicker' }, 'Pemakaian'), el('p', { class: 'muted' }, 'Rincian pemakaian tersedia setelah sidang selesai.'))
    ]
  }

  // ---------- render ----------

  function render() {
    const stage = stageOf(state, run || {})
    renderSide(stage)
    renderHead()
    renderTabs()
    const content =
      view.tab === 'riset' ? renderResearch() : view.tab === 'debat' ? renderDebate() : view.tab === 'klaim' ? renderClaims() : view.tab === 'detail' ? renderDetail() : renderSummary(stage)
    panel.replaceChildren(...content.filter(Boolean))
  }

  render()

  return {
    state,
    update(data) {
      error = null
      for (const e of data.events || []) applyEvent(state, e)
      run = data.run
      // Sidang baru selesai saat sedang dibuka: tampilkan hasil.
      if (state.finished && data.events?.some((e) => e.type === 'finished')) view.tab = 'ringkasan'
      render()
    },
    showError(message) {
      error = message
      renderHead()
    },
    destroy() {
      clearInterval(ticker)
    }
  }
}

