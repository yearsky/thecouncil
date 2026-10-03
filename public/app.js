// UI The Council: tanpa framework. Halaman sidang ada di run-view.js; helper bersama di ui.js.

import { $, POLL_MS, STATUS, api, badge, el, setUnauthorizedHandler, time } from './ui.js'
import { createRunPage } from './run-view.js'

// ---------- navigasi ----------

let pollTimer = null
let page = null
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
  page?.destroy()
  page = null
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
    $('#research').checked = config.defaults.research !== false
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
    research: $('#research').checked,
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

async function openRun(id) {
  show('sidang')
  window.scrollTo(0, 0)
  page = createRunPage({ id, api, root: $('#view-sidang') })
  const current = page
  let next = 0
  const poll = async () => {
    if (page !== current) return
    try {
      const data = await api(`runs/${encodeURIComponent(id)}/events/${next}`)
      if (page !== current) return
      next = data.next
      current.update(data)
      if (data.run.status === 'running' || data.events.length) pollTimer = setTimeout(poll, data.events.length ? 300 : POLL_MS)
    } catch (err) {
      if (err.message === 'belum login' || page !== current) return
      current.showError(err.message)
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
      ...[...report.results, ...(report.literature ? [report.literature] : [])].map((r) =>
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

setUnauthorizedHandler(showLogin)

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
