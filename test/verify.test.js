import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createVerifier, htmlToText, matchQuote, normalizeText, normalizeUrl } from '../src/evidence/verify.js'

async function startSourceServer() {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type })
      res.end(body)
    }
    switch (req.url) {
      case '/page':
        return send(200, 'text/html; charset=utf-8', '<html><head><title>x</title></head><body><p>IASC menerima <b>411.055</b> laporan penipuan per 23 Desember 2025, dengan kerugian Rp9&nbsp;triliun.</p><script>var rahasia = "SPAM";</script></body></html>')
      case '/plain':
        return send(200, 'text/plain', 'Penetrasi internet 80,66% menurut survei.')
      case '/pdf':
        return send(200, 'application/pdf', '%PDF-1.4')
      case '/forbidden':
        return send(403, 'text/html', 'no bots')
      case '/gone':
        return send(404, 'text/html', 'not found')
      case '/slow':
        return setTimeout(() => send(200, 'text/html', 'lambat'), 2000)
      default:
        return send(500, 'text/plain', 'error')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) }
}

test('normalizeText: huruf kecil, Rp9 = Rp 9, titik/koma angka dipertahankan, tanda kutip seragam', () => {
  assert.equal(normalizeText('Rp9 Triliun'), normalizeText('rp 9 triliun'))
  assert.equal(normalizeText('“411.055 laporan”, kata OJK.'), '411.055 laporan kata ojk')
  assert.equal(normalizeText('80,66%'), '80,66%')
  assert.equal(normalizeText('Énergie'), 'energie')
})

test('htmlToText membuang script dan tag, mengubah entitas', () => {
  const text = htmlToText('<head><title>t</title></head><p>A&amp;B&nbsp;C &#65; &#x42;</p><script>x()</script>')
  assert.match(text, /A&B C A B/)
  assert.doesNotMatch(text, /x\(\)/)
})

test('matchQuote: persis, mirip (≥60% trigram), atau tidak cocok', () => {
  const page = 'IASC menerima 411.055 laporan penipuan per 23 Desember 2025 dengan kerugian Rp 9 triliun'
  assert.equal(matchQuote('menerima 411.055 laporan penipuan', page), 'exact')
  assert.equal(matchQuote('IASC menerima 411.055 laporan penipuan per 23 Desember 2024', page), 'partial')
  assert.equal(matchQuote('BPS mencatat 68,65% penduduk memiliki ponsel', page), null)
  assert.equal(matchQuote('', page), null)
})

test('normalizeUrl membuang fragmen, parameter pelacak, dan garis miring akhir', () => {
  assert.equal(normalizeUrl('https://Example.com/a/?utm_source=x&id=2#bagian'), 'https://example.com/a/?id=2')
  assert.equal(normalizeUrl('https://example.com/a/'), 'https://example.com/a')
})

test('verifier: semua status, dan halaman yang sama hanya diunduh sekali', async (t) => {
  const srv = await startSourceServer()
  t.after(srv.close)
  const u = (p) => `${srv.url}${p}`
  const claims = [
    { id: 'K1', source_url: u('/page'), quote: 'IASC menerima 411.055 laporan penipuan' },
    { id: 'K2', source_url: u('/page#atas'), quote: 'IASC menerima 411.055 laporan penipuan per 23 Desember 2024' },
    { id: 'K3', source_url: u('/page'), quote: 'angka ini tidak ada di halaman sama sekali' },
    { id: 'K4', source_url: u('/page'), quote: '' },
    { id: 'K5', source_url: u('/plain'), quote: 'Penetrasi internet 80,66%' },
    { id: 'K6', source_url: u('/pdf'), quote: 'x' },
    { id: 'K7', source_url: u('/forbidden'), quote: 'x' },
    { id: 'K8', source_url: u('/gone'), quote: 'x' },
    { id: 'K9', source_url: '', quote: '' },
    { id: 'K10', source_url: u('/slow'), quote: 'lambat' },
    { id: 'K11', source_url: 'bukan-url', quote: 'x' },
    { id: 'K12', source_url: 'ftp://example.com/a', quote: 'x' }
  ]
  const verify = createVerifier({ timeoutMs: 500 })
  const r = await verify(claims)
  const status = Object.fromEntries([...r].map(([id, v]) => [id, v.status]))
  assert.deepEqual(status, {
    K1: 'verified',
    K2: 'quote_partial',
    K3: 'quote_not_found',
    K4: 'no_quote',
    K5: 'verified',
    K6: 'unverifiable',
    K7: 'unverifiable',
    K8: 'unreachable',
    K9: 'no_source',
    K10: 'unverifiable',
    K11: 'unreachable',
    K12: 'unreachable'
  })
  assert.equal(r.get('K7').detail, 'HTTP 403')
  assert.equal(r.get('K10').detail, 'timeout')
  assert.equal(srv.hits.filter((h) => h === '/page').length, 1)

  // Cache dipakai lagi di ronde berikutnya.
  await verify([{ id: 'K13', source_url: u('/page'), quote: 'kerugian Rp9 triliun' }])
  assert.equal(srv.hits.filter((h) => h === '/page').length, 1)
})

test('verifier: domain yang tidak ada dicatat "sumber tidak ada"', async () => {
  const verify = createVerifier({ fetcher: async () => ({ status: 'unreachable', detail: 'domain tidak ditemukan' }) })
  const r = await verify([{ id: 'K1', source_url: 'https://tidak-ada.invalid/x', quote: 'q' }])
  assert.deepEqual(r.get('K1'), { status: 'unreachable', detail: 'domain tidak ditemukan', httpStatus: undefined })
})
