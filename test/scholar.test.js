import test from 'node:test'
import assert from 'node:assert/strict'
import { abstractFromInvertedIndex, mergeAndRank, paperText, parseArxiv, parseOpenAlex, parseSemanticScholar, requestFor, searchLiterature } from '../src/evidence/scholar.js'

const S2 = {
  total: 2,
  data: [
    {
      paperId: 'a1',
      title: 'Credit scoring for smallholder farmers using satellite data',
      year: 2023,
      venue: 'World Development',
      authors: [{ name: 'Sari Dewi' }],
      citationCount: 40,
      externalIds: { DOI: '10.1000/ABC.1' },
      url: 'https://www.semanticscholar.org/paper/a1',
      abstract: 'Smallholder farmers lack formal credit histories. We show satellite vegetation indices predict repayment.',
      tldr: { text: 'Satellite data predicts smallholder loan repayment.' }
    },
    { paperId: 'a2', title: 'Old survey without abstract', year: 2001, citationCount: 3, externalIds: {}, url: 'https://www.semanticscholar.org/paper/a2', abstract: null, tldr: null }
  ]
}

const OPENALEX = {
  results: [
    {
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/abc.1',
      display_name: 'Credit Scoring for Smallholder Farmers Using Satellite Data',
      publication_year: 2023,
      cited_by_count: 55,
      abstract_inverted_index: { Smallholder: [0], farmers: [1], lack: [2], credit: [3] },
      primary_location: { landing_page_url: 'https://journal.example/abc1', source: { display_name: 'World Development' } },
      authorships: [{ author: { display_name: 'Sari Dewi' } }]
    },
    {
      id: 'https://openalex.org/W2',
      doi: null,
      display_name: 'Cold chain losses in Indonesian fisheries',
      publication_year: 2024,
      cited_by_count: 2,
      abstract_inverted_index: { Post: [0], harvest: [1], 'losses…': [2] },
      primary_location: { landing_page_url: 'https://repository.example.ac.id/123', source: null },
      authorships: []
    }
  ]
}

const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <published>2024-01-03T00:00:00Z</published>
    <title>Retrieval  for low-resource
      Indonesian &amp; Javanese</title>
    <summary>We study retrieval &lt;in&gt; low-resource languages.</summary>
    <author><name>Budi</name></author>
    <author><name>Ani</name></author>
  </entry>
</feed>`

test('abstrak OpenAlex dari inverted index', () => {
  assert.equal(abstractFromInvertedIndex({ world: [1], Hello: [0], again: [3], ',': [2] }), 'Hello world , again')
  assert.equal(abstractFromInvertedIndex(null), '')
})

test('parser Semantic Scholar, OpenAlex, arXiv', () => {
  const s2 = parseSemanticScholar(S2)
  assert.equal(s2[0].url, 'https://doi.org/10.1000/ABC.1')
  assert.equal(s2[0].doi, '10.1000/abc.1')
  assert.equal(s2[0].tldr, 'Satellite data predicts smallholder loan repayment.')
  assert.equal(s2[1].abstract, '')

  const oa = parseOpenAlex(OPENALEX)
  assert.equal(oa[0].doi, '10.1000/abc.1')
  assert.equal(oa[0].abstract, 'Smallholder farmers lack credit')
  assert.equal(oa[1].url, 'https://repository.example.ac.id/123')

  const ax = parseArxiv(ARXIV)
  assert.equal(ax.length, 1)
  assert.equal(ax[0].title, 'Retrieval for low-resource Indonesian & Javanese')
  assert.equal(ax[0].abstract, 'We study retrieval <in> low-resource languages.')
  assert.equal(ax[0].url, 'https://arxiv.org/abs/2401.01234')
  assert.equal(ax[0].year, 2024)
  assert.deepEqual(ax[0].authors, ['Budi', 'Ani'])
})

test('gabung DOI yang sama, buang yang tanpa abstrak, urutkan, beri ID S', () => {
  const found = [
    ...parseSemanticScholar(S2).map((paper) => ({ paper, query: 'q1' })),
    ...parseOpenAlex(OPENALEX).map((paper) => ({ paper, query: 'q2' }))
  ]
  const papers = mergeAndRank(found, { now: new Date('2026-10-01') })
  assert.deepEqual(
    papers.map((p) => p.id),
    ['S1', 'S2']
  )
  assert.equal(papers[0].doi, '10.1000/abc.1')
  assert.deepEqual(papers[0].foundIn, ['semanticscholar', 'openalex'])
  assert.deepEqual(papers[0].queries, ['q1', 'q2'])
  assert.equal(papers[0].citations, 55)
  assert.ok(papers[0].altUrls.includes('https://journal.example/abc1'))
  assert.equal(papers[1].title, 'Cold chain losses in Indonesian fisheries')
  assert.match(paperText(papers[0]), /Satellite data predicts/)
})

test('permintaan: key dikirim lewat header, bukan URL; tanpa key tanpa header', () => {
  const env = { OPENALEX_API_KEY: 'oa-key', SEMANTIC_SCHOLAR_API_KEY: 's2-key' }
  const oa = requestFor('openalex', 'kredit petani', { env })
  assert.equal(oa.headers.Authorization, 'Bearer oa-key')
  assert.doesNotMatch(oa.url, /oa-key/)
  assert.match(oa.url, /search=kredit%20petani/)
  assert.equal(requestFor('semanticscholar', 'x', { env }).headers['x-api-key'], 's2-key')
  assert.equal(requestFor('semanticscholar', 'x', { env: {} }).headers['x-api-key'], undefined)
  assert.match(requestFor('arxiv', 'credit (scoring) "farmers"', {}).url, /search_query=all:credit\+AND\+all:scoring\+AND\+all:farmers/)
  assert.throws(() => requestFor('scholar-x', 'q'), /tidak dikenal/)
})

test('satu sumber dibatasi (429) tidak menghentikan sumber lain', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('semanticscholar')) return new Response('{"message":"Too Many Requests"}', { status: 429 })
    if (url.includes('openalex')) return new Response(JSON.stringify(OPENALEX), { status: 200 })
    return new Response(ARXIV, { status: 200 })
  }
  const r = await searchLiterature(['q1', 'q2'], { fetchImpl, gaps: { semanticscholar: 0, openalex: 0, arxiv: 0 }, now: new Date('2026-10-01'), env: {} })
  assert.equal(calls.filter((u) => u.includes('semanticscholar')).length, 1, 'berhenti setelah 429')
  assert.deepEqual(r.errors.map((e) => [e.source, e.message]), [['semanticscholar', 'HTTP 429 (dibatasi)']])
  assert.equal(r.stats.openalex.queries, 2)
  assert.equal(r.papers.length, 3)
  assert.ok(r.papers.every((p, i) => p.id === `S${i + 1}`))
})

test('jaringan putus dicatat sebagai error sumber, bukan exception', async () => {
  const fetchImpl = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }
  const r = await searchLiterature(['q'], { sources: ['openalex'], fetchImpl, env: {} })
  assert.deepEqual(r.papers, [])
  assert.deepEqual(r.errors, [{ source: 'openalex', query: 'q', message: 'ECONNREFUSED' }])
})
