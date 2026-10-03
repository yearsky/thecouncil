// UI The Council: tanpa framework. Semua teks dari model dimasukkan sebagai teks (bukan HTML), kecuali draft
// Markdown yang dirender oleh md() setelah di-escape.

const $ = (sel) => document.querySelector(sel)
const POLL_MS = 2500

const VOTE = { AGREE: ['✔ setuju', 'ok'], AGREE_WITH_RESERVATIONS: ['◐ setuju dengan catatan', 'warn'], DISAGREE: ['✖ tidak setuju', 'bad'] }
const STATUS = {
  unanimous: ['✔ bulat', 'ok'],
  majority: ['◐ mayoritas', 'warn'],
  no_consensus: ['✖ tidak ada konsensus', 'bad'],
  error: ['✖ gagal', 'bad'],
  running: ['berjalan', 'info'],
  finished: ['selesai', 'ok'],
  cancelled: ['dibatalkan', 'warn']
}
// Sama dengan VERIFY_STATUS di src/evidence/verify.js.
const VERIFY = {
  verified: ['✅', 'kutipan ditemukan'],
  quote_partial: ['⚠️', 'kutipan mirip, tidak persis'],
  quote_not_found: ['⚠️', 'halaman terbuka, kutipan tidak ditemukan'],
  no_quote: ['⚠️', 'halaman terbuka, tanpa kutipan'],
  unverifiable: ['❔', 'tidak bisa dicek otomatis'],
  unreachable: ['❌', 'sumber tidak ada atau alamat salah'],
  no_source: ['➖', 'klaim fakta tanpa sumber']
}
const FLAG = {
  contradictory_vote: 'menyatakan setuju tapi menulis keberatan pemblokir (dihitung tidak setuju)',
  unexplained_flip: 'suara berubah tanpa penjelasan',
  change_without_reason: 'berubah pendapat tanpa menyebut alasan',
  unknown_citation: 'merujuk ID klaim yang tidak ada'
}

// ---------- utilitas DOM ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const badge = ([text, tone]) => el('span', { class: `badge ${tone || ''}` }, text)
const secs = (ms) => `${(ms / 1000).toFixed(1)} dtk`
const num = (n) => Math.round(n || 0).toLocaleString('id-ID')
const time = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '')

// Markdown kecil yang aman: teks di-escape dulu, lalu hanya pola sederhana yang diubah.
function md(source) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  const lines = String(source || '').split('\n')
  const out = []
  let list = null
  let para = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flushPara()
      closeList()
      const code = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushPara()
      closeList()
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(line)
      i++
      const rows = []
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]))
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      )
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushPara()
      closeList()
      const level = Math.min(6, heading[1].length + 2)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const item = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/)
    if (item) {
      flushPara()
      const type = /\d/.test(item[1]) ? 'ol' : 'ul'
      if (list !== type) {
        closeList()
        out.push(`<${type}>`)
        list = type
      }
      out.push(`<li>${inline(item[2])}</li>`)
      continue
    }
    if (!line.trim()) {
      flushPara()
      closeList()
      continue
    }
    closeList()
    para.push(line.trim())
  }
  flushPara()
  closeList()
  const box = el('div', { class: 'md' })
  box.innerHTML = out.join('\n')
  return box
}

// ---------- API ----------

// Rute dikirim lewat ?path= (bukan /api/<rute>), karena di Vercel rewrite /api/<rute> tidak sampai ke fungsi.
const apiUrl = (path) => `/api?path=${encodeURIComponent(path)}`

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  })
  const type = res.headers.get('content-type') || ''
  const data = type.includes('json') ? await res.json() : await res.text()
  if (res.status === 401 && path !== 'login') {
    showLogin()
    throw new Error('belum login')
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.data = data
    throw err
  }
  return data
}

// ---------- navigasi ----------

let pollTimer = null
let cache = { config: null }

function show(view) {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`
  for (const link of document.querySelectorAll('nav a')) link.classList.toggle('active', link.dataset.tab === view)
}

function showLogin() {
  $('#nav').hidden = true
  show('login')
  $('#password').focus()
}

async function route() {
  clearTimeout(pollTimer)
  const hash = location.hash.replace(/^#\/?/, '') || 'baru'
  const [name, arg] = hash.split('/')
  const [view, query] = name.split('?')
  $('#nav').hidden = false
  try {
    if (view === 'sidang' && arg) return await openRun(decodeURIComponent(arg))
    if (view === 'riwayat') return await openHistory()
    if (view === 'cek') return show('cek')
    return await openNew(new URLSearchParams(query || ''))
  } catch (err) {
    if (err.message !== 'belum login') console.error(err)
  }
}

// ---------- sidang baru ----------

async function openNew(params) {
  show('baru')
  const config = (cache.config ||= await api('config'))
  const box = $('#model-fields')
  if (!box.dataset.ready) {
    let models = []
    try {
      models = (await api('models')).models
      $('#model-hint').textContent = models.length ? 'Daftar model diambil dari API (GET /models).' : ''
    } catch (err) {
      $('#model-hint').textContent = `Daftar model tidak bisa diambil (${err.message}). Isi nama model secara manual.`
    }
    const field = (id, label, value, includeSame) => {
      if (!models.length) return el('label', {}, label, el('input', { type: 'text', 'data-agent': id, value, placeholder: includeSame ? 'kosong = sama dengan agennya' : 'nama model' }))
      const options = [...new Set([value, ...models].filter(Boolean))]
      const select = el('select', { 'data-agent': id }, includeSame ? el('option', { value: '' }, 'sama dengan agennya') : el('option', { value: '' }, '— pilih —'), options.map((m) => el('option', { value: m }, m)))
      select.value = value || (includeSame ? '' : models[0] || '')
      return el('label', {}, label, select)
    }
    box.replaceChildren(
      ...config.panel.map((a) => field(a.id, `${a.label} (panelis)`, a.model, false)),
      field('__moderator', `Moderator (${config.moderator.label})`, config.moderator.model, true)
    )
    const rounds = $('#rounds')
    rounds.replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('option', { value: n }, n)))
    rounds.value = String(config.defaults.maxRounds)
    $('#consensus').value = config.defaults.consensus
    $('#web').checked = config.defaults.web
    $('#verify').checked = config.defaults.verify
    $('#topic').maxLength = config.limits.maxTopicChars
    box.dataset.ready = '1'
  }
  const { runs } = await api('memories')
  const preselect = new Set(params.getAll('lanjut'))
  $('#memory-box').hidden = runs.length === 0
  $('#memory-list').replaceChildren(
    ...runs.map((r) => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: r.id, checked: preselect.has(r.id) }), `${r.topic} · ${time(r.finishedAt)}`))
  )
  if (preselect.size) $('#topic').focus()
}

async function submitRun(event) {
  event.preventDefault()
  const button = $('#start')
  $('#run-error').replaceChildren()
  const models = {}
  let moderatorModel
  for (const input of document.querySelectorAll('#model-fields [data-agent]')) {
    if (input.dataset.agent === '__moderator') moderatorModel = input.value
    else models[input.dataset.agent] = input.value
  }
  const body = {
    topic: $('#topic').value,
    maxRounds: Number($('#rounds').value),
    consensus: $('#consensus').value,
    web: $('#web').checked,
    verify: $('#verify').checked,
    models,
    moderatorModel,
    memory: [...document.querySelectorAll('#memory-list input:checked')].map((i) => i.value)
  }
  button.disabled = true
  try {
    const { run } = await api('runs', { method: 'POST', body })
    $('#topic').value = ''
    location.hash = `#/sidang/${encodeURIComponent(run.id)}`
  } catch (err) {
    const msg = [err.message]
    if (err.data?.active) msg.push(' ', el('a', { href: `#/sidang/${encodeURIComponent(err.data.active)}` }, 'Buka sidang yang berjalan'))
    $('#run-error').replaceChildren(...msg)
  } finally {
    button.disabled = false
  }
}

// ---------- riwayat ----------

async function openHistory() {
  show('riwayat')
  const { runs } = await api('runs')
  const list = $('#run-list')
  if (!runs.length) return list.replaceChildren(el('p', { class: 'note' }, 'Belum ada sidang.'))
  list.replaceChildren(
    ...runs.map((r) =>
      el(
        'a',
        { class: 'card run-item', href: `#/sidang/${encodeURIComponent(r.id)}` },
        el('span', { class: 'grow' }, r.topic),
        badge(STATUS[r.status] || [r.status]),
        el('span', { class: 'meta note' }, time(r.createdAt))
      )
    )
  )
}

// ---------- jalannya sidang ----------

function createRunView(id) {
  const state = { id, next: 0, labels: {}, moderator: 'Moderator', claims: new Map(), done: false, finished: null }
  const timeline = $('#timeline')
  timeline.replaceChildren()
  $('#claims-box').hidden = true
  const pending = new Map()
  const name = (agent) => state.labels[agent] || agent

  function add(node) {
    timeline.append(node)
    return node
  }

  function chipText(cid) {
    const c = state.claims.get(cid)
    return `${cid} ${c?.verification ? VERIFY[c.verification.status]?.[0] || '?' : '·'}`
  }

  function claimChips(response) {
    const ids = [...new Set([...(response.claims || []).map((c) => c.id), ...(response.cited_claims || [])])]
    if (!ids.length) return null
    return el(
      'div',
      { class: 'chips' },
      ids.map((cid) => el('span', { class: 'chip', 'data-claim': cid, title: state.claims.get(cid)?.text || cid }, chipText(cid)))
    )
  }

  function renderClaims() {
    // Chip klaim di jawaban lama ikut diperbarui setelah verifikasi.
    for (const chip of timeline.querySelectorAll('.chip[data-claim]')) chip.textContent = chipText(chip.dataset.claim)
    const claims = [...state.claims.values()]
    $('#claims-box').hidden = claims.length === 0
    $('#claims-count').textContent = `(${claims.length})`
    $('#claims-table').replaceChildren(
      el('thead', {}, el('tr', {}, ['ID', 'Klaim', 'Jenis', 'Sumber', 'Verifikasi', 'Oleh'].map((h) => el('th', {}, h)))),
      el(
        'tbody',
        {},
        claims.map((c) =>
          el(
            'tr',
            {},
            el('td', {}, c.id),
            el('td', {}, c.text),
            el('td', {}, c.kind),
            el('td', { class: 'url' }, c.source_url ? el('a', { href: c.source_url, target: '_blank', rel: 'noopener noreferrer' }, c.source_url) : '–', c.quote ? el('div', { class: 'note' }, `"${c.quote}"`) : null),
            el('td', {}, c.verification ? `${VERIFY[c.verification.status]?.[0] || '?'} ${c.verification.detail || VERIFY[c.verification.status]?.[1] || ''}` : '· belum dicek'),
            el('td', {}, [...(c.by || [])].map(name).join(', '))
          )
        )
      )
    )
  }

  function voteLine(vote) {
    if (!vote) return null
    return el(
      'div',
      {},
      badge(VOTE[vote.on_draft] || [vote.on_draft]),
      vote.blocking_objections?.length ? el('ul', {}, vote.blocking_objections.map((o) => el('li', {}, `Keberatan: ${o}`))) : null,
      vote.reservations?.length ? el('ul', {}, vote.reservations.map((o) => el('li', {}, `Catatan: ${o}`))) : null,
      vote.change_reason ? el('div', { class: 'note' }, `Alasan berubah: ${vote.change_reason}`) : null
    )
  }

  function handle(e) {
    switch (e.type) {
      case 'session_started': {
        for (const p of e.panel) state.labels[p.id] = p.alias ? `${p.alias} · ${p.label}` : p.label
        state.labels.memori = 'sidang sebelumnya'
        state.moderator = `Moderator · ${e.moderator.label}`
        for (const c of e.memoryClaims || []) state.claims.set(c.id, { ...c, by: new Set(['memori']) })
        renderClaims()
        add(
          el(
            'div',
            { class: 'card' },
            el('h1', {}, e.topic),
            el('div', { class: 'note' }, `Panel: ${e.panel.map((p) => `${p.label}${p.model ? ` (${p.model})` : ''}${p.alias ? ` = ${p.alias}` : ''}`).join(' · ')}`),
            el(
              'div',
              { class: 'note' },
              `Moderator: ${e.moderator.label}${e.moderator.model ? ` (${e.moderator.model})` : ''} · maks. ${e.maxRounds} ronde · konsensus ${e.consensus === 'majority' ? 'mayoritas' : 'bulat'} · web ${e.web ? 'aktif' : 'mati'} · verifikasi ${e.verify ? 'aktif' : 'mati'}`
            ),
            (e.memory || []).map((m) => el('div', { class: 'note' }, `Melanjutkan: ${m.question} (${m.claims} klaim ✅ dibawa)`))
          )
        )
        break
      }
      case 'framed':
        add(
          el(
            'div',
            { class: 'card msg moderator' },
            el('div', { class: 'who' }, state.moderator),
            el('div', {}, el('strong', {}, 'Pertanyaan sidang: '), e.question),
            e.criteria?.length ? el('ul', {}, e.criteria.map((c) => el('li', {}, c))) : null,
            e.context ? el('div', { class: 'note' }, `Konteks: ${e.context}`) : null
          )
        )
        break
      case 'warning':
        add(el('div', { class: 'note warn' }, `⚠ ${e.message}`))
        break
      case 'cancelled':
        add(el('div', { class: 'note warn' }, e.message || 'Sidang dibatalkan.'))
        break
      case 'round_started': {
        const title = e.mode === 'blind' ? `Ronde ${e.round} (blind)` : e.mode === 'critique' ? `Ronde ${e.round} (kritik)` : 'Pemungutan suara akhir'
        add(el('h2', { class: 'round-title' }, title))
        if (e.devilsAdvocate) add(el('div', { class: 'note' }, `Devil's advocate ronde ini: ${name(e.devilsAdvocate)}`))
        break
      }
      case 'agent_started':
        pending.set(`${e.round}:${e.agent}`, add(el('div', { class: 'card waiting' }, `${name(e.agent)} sedang menjawab…`)))
        break
      case 'agent_finished':
      case 'agent_failed': {
        const key = `${e.round}:${e.agent}`
        const r = e.response || {}
        for (const c of r.claims || []) {
          const known = state.claims.get(c.id)
          state.claims.set(c.id, { ...c, ...(known || {}), by: new Set([...(known?.by || []), e.agent]) })
        }
        const tokens = e.usage?.tokens
        const meta = [e.ms !== undefined ? secs(e.ms) : null, tokens ? `${num(tokens.input + tokens.cacheRead + tokens.cacheWrite)} token masuk · ${num(tokens.output)} keluar` : null, e.repaired ? 'format diperbaiki' : null]
          .filter(Boolean)
          .join(' · ')
        const card =
          e.type === 'agent_failed'
            ? el('div', { class: 'card msg' }, el('div', { class: 'who' }, name(e.agent), badge(['gagal', 'bad'])), el('code', {}, e.error))
            : el(
                'div',
                { class: 'card msg' },
                el('div', { class: 'who' }, name(e.agent), el('span', { class: 'meta' }, meta)),
                r.position ? el('p', {}, r.position) : null,
                r.proposals?.length ? el('ul', {}, r.proposals.map((p) => el('li', {}, el('strong', {}, `${p.id || ''} ${p.title}`), p.why ? ` — ${p.why}` : ''))) : null,
                claimChips(r),
                r.critiques?.length ? el('details', {}, el('summary', {}, `Kritik (${r.critiques.length})`), el('ul', {}, r.critiques.map((c) => el('li', {}, `[${c.severity}]${c.target ? ` ${c.target}:` : ''} ${c.point}`)))) : null,
                r.changed_mind?.changed ? el('div', { class: 'note' }, `Berubah pendapat: ${r.changed_mind.what} (karena: ${r.changed_mind.because || 'tidak disebutkan'})`) : null,
                voteLine(r.vote)
              )
        const placeholder = pending.get(key)
        if (placeholder) placeholder.replaceWith(card)
        else add(card)
        pending.delete(key)
        renderClaims()
        break
      }
      case 'verified': {
        for (const v of e.claims || []) {
          const c = state.claims.get(v.id)
          if (c) c.verification = { status: v.status, detail: v.detail }
        }
        const counts = Object.entries(e.counts || {}).map(([s, n]) => `${VERIFY[s]?.[0] || s} ${n}`)
        add(el('div', { class: 'note' }, `Verifikasi sumber oleh program: ${e.total} klaim dicek · ${counts.join(' · ')}`))
        renderClaims()
        break
      }
      case 'flags':
        add(el('div', { class: 'note warn' }, el('strong', {}, 'Catatan integritas: '), e.flags.map((f) => `${name(f.agent)} ${FLAG[f.type] || f.type}${f.detail ? ` (${f.detail})` : ''}`).join('; ')))
        break
      case 'votes':
        add(el('div', { class: 'note' }, `Suara atas draft ronde ${e.draftRound}: ${e.accepted?.length ?? 0} dari ${e.total} setuju `, badge(STATUS[e.status] || [e.status])))
        break
      case 'judged':
        add(
          el(
            'div',
            { class: 'card msg moderator' },
            el('div', { class: 'who' }, state.moderator, el('span', { class: 'meta' }, `rangkuman ronde ${e.round}`)),
            el('p', {}, e.summary),
            e.agreements?.length ? el('div', {}, el('strong', {}, 'Disepakati'), el('ul', {}, e.agreements.map((a) => el('li', {}, a)))) : null,
            e.disagreements?.length ? el('div', {}, el('strong', {}, 'Masih diperdebatkan'), el('ul', {}, e.disagreements.map((a) => el('li', {}, a)))) : null,
            el('details', {}, el('summary', {}, 'Draft kesimpulan'), md(e.draft)),
            e.next_focus ? el('div', { class: 'note' }, `Fokus berikutnya: ${e.next_focus}`) : null
          )
        )
        break
      case 'finished': {
        state.finished = e
        const u = e.usage || {}
        const tokens = u.tokens || {}
        const verified = Object.entries(e.verification || {}).map(([s, n]) => `${VERIFY[s]?.[0] || s} ${n}`).join(' · ')
        add(
          el(
            'div',
            { class: 'card msg final' },
            el('div', { class: 'who' }, 'Hasil sidang', badge(STATUS[e.status] || [e.status]), e.decidedBy === 'vote' ? el('span', { class: 'meta' }, '(suara akhir)') : null),
            e.summary ? el('p', {}, e.summary) : null,
            e.draft ? md(e.draft) : el('p', { class: 'note' }, 'Sidang tidak menghasilkan kesimpulan.'),
            el(
              'div',
              { class: 'note' },
              [
                verified ? `Klaim: ${verified}` : null,
                u.calls ? `${u.calls} panggilan AI` : null,
                tokens.output !== undefined ? `${num(tokens.input + tokens.cacheRead + tokens.cacheWrite)} token masuk (${num(tokens.cacheRead)} dari cache) · ${num(tokens.output)} keluar` : null,
                u.costUsd ? `estimasi $${u.costUsd.toFixed(4)}` : null,
                u.truncated ? `⚠️ ${u.truncated} jawaban kena batas maxTokens` : null
              ]
                .filter(Boolean)
                .join(' · ')
            ),
            el(
              'div',
              { class: 'row' },
              el('a', { href: apiUrl(`runs/${id}/report`), download: `${id}.md` }, el('button', { type: 'button', class: 'secondary' }, 'Unduh laporan (.md)')),
              el('a', { href: `#/baru?lanjut=${encodeURIComponent(id)}` }, el('button', { type: 'button' }, 'Lanjutkan sidang ini'))
            )
          )
        )
        break
      }
      default:
        break
    }
  }

  return { state, handle }
}

function renderStatus(run, view) {
  const bar = $('#run-status')
  const label = run.status === 'running' ? (run.active ? ['berjalan', 'info'] : ['dijeda, menunggu dilanjutkan', 'warn']) : STATUS[run.status] || [run.status]
  const cancel =
    run.status === 'running'
      ? el(
          'button',
          {
            type: 'button',
            class: 'secondary',
            onclick: async (ev) => {
              if (!confirm('Batalkan sidang ini? Panggilan yang sedang berjalan tetap diselesaikan dulu.')) return
              ev.target.disabled = true
              await api(`runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' }).catch((err) => alert(err.message))
            }
          },
          'Batalkan'
        )
      : null
  const parts = [
    el('span', { class: 'grow' }, el('strong', {}, run.topic)),
    badge(label),
    run.status === 'running' ? el('span', { class: 'note' }, `slice ${run.slices}`) : null,
    run.error ? el('span', { class: 'note warn' }, run.error) : null,
    cancel
  ]
  bar.replaceChildren(...parts.filter(Boolean))
}

async function openRun(id) {
  show('sidang')
  $('#run-status').replaceChildren(el('span', { class: 'waiting' }, 'Memuat sidang…'))
  const view = createRunView(id)
  const poll = async () => {
    try {
      const data = await api(`runs/${encodeURIComponent(id)}/events/${view.state.next}`)
      for (const e of data.events) view.handle(e)
      view.state.next = data.next
      renderStatus(data.run, view)
      if (data.run.status === 'running' || data.events.length) pollTimer = setTimeout(poll, data.events.length ? 300 : POLL_MS)
    } catch (err) {
      if (err.message === 'belum login') return
      $('#run-status').replaceChildren(el('span', { class: 'error' }, err.message))
      pollTimer = setTimeout(poll, POLL_MS * 2)
    }
  }
  await poll()
}

// ---------- cek agen ----------

const CHECK_ICON = { ok: ['✔', 'ok'], warn: ['⚠', 'warn'], fail: ['✖', 'bad'], skip: ['–', ''], info: ['•', 'info'] }

async function runDoctor(quick) {
  const out = $('#doctor-result')
  out.replaceChildren(el('div', { class: 'card waiting' }, quick ? 'Memeriksa…' : 'Memeriksa agen (bisa 1–3 menit)…'))
  for (const b of document.querySelectorAll('#view-cek button')) b.disabled = true
  try {
    const report = await api(quick ? 'doctor/quick' : 'doctor')
    out.replaceChildren(
      ...report.results.map((r) =>
        el(
          'div',
          { class: 'card stack' },
          el('div', { class: 'who' }, badge(CHECK_ICON[r.status] || [r.status]), ' ', el('strong', {}, r.label), el('span', { class: 'note' }, ` (${r.type})`)),
          r.checks.map((c) =>
            el('div', { class: 'check-line' }, el('span', {}, CHECK_ICON[c.status]?.[0] || c.status), el('span', {}, c.name), el('span', {}, c.detail), c.answer ? el('span', { class: 'answer' }, `↳ "${c.answer}"`) : null)
          )
        )
      )
    )
  } catch (err) {
    out.replaceChildren(el('p', { class: 'error' }, err.message))
  } finally {
    for (const b of document.querySelectorAll('#view-cek button')) b.disabled = false
  }
}

// ---------- awal ----------

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  $('#login-error').textContent = ''
  try {
    await api('login', { method: 'POST', body: { password: $('#password').value } })
    $('#password').value = ''
    $('#logout').hidden = false
    route()
  } catch (err) {
    $('#login-error').textContent = err.message
  }
})
$('#logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST' }).catch(() => {})
  showLogin()
})
$('#run-form').addEventListener('submit', submitRun)
$('#doctor-quick').addEventListener('click', () => runDoctor(true))
$('#doctor-full').addEventListener('click', () => runDoctor(false))
window.addEventListener('hashchange', route)

const me = await api('me').catch(() => ({ loggedIn: false, authRequired: true }))
$('#logout').hidden = !me.authRequired
if (me.loggedIn) route()
else showLogin()
