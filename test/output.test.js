import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCouncil } from '../src/council/protocol.js'
import { buildReport, demoteHeadings } from '../src/council/report.js'
import { createSession, slugify, stamp } from '../src/store/session.js'
import { createTerminalRenderer } from '../src/ui/terminal.js'
import { createStyle } from '../src/ui/style.js'
import { fakeBin, scriptedAgent, startFakeApi } from './helpers.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function sampleRun(panel, opts = {}) {
  const events = []
  let t = Date.parse('2026-10-02T08:00:00Z')
  const result = await runCouncil({
    topic: 'Ide hackathon | UMKM',
    panel,
    moderator: { agent: panel[0], model: 'opus' },
    emit: (e) => events.push(e),
    clock: () => new Date((t += 60000)),
    random: () => 0.999999,
    ...opts
  })
  return { result, events }
}

test('slugify dan stamp aman untuk nama folder Windows', () => {
  assert.equal(slugify('Ide Hackathon: Keuangan UMKM (48 jam)!'), 'ide-hackathon-keuangan-umkm-48-jam')
  assert.equal(slugify('Ápa kabar?'), 'apa-kabar')
  assert.equal(slugify('???'), 'sidang')
  assert.equal(slugify('a'.repeat(60)).length, 40)
  assert.equal(stamp(new Date(2026, 9, 2, 8, 5, 9)), '2026-10-02_080509')
})

test('createSession menulis events.jsonl dan report.md', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'council-session-'))
  const s = createSession({ topic: 'Uji sesi', baseDir: base, now: new Date(2026, 9, 2, 8, 0, 0) })
  assert.equal(s.id, '2026-10-02_080000_uji-sesi')
  s.append({ type: 'a' })
  s.append({ type: 'b' })
  s.writeReport('# laporan')
  assert.deepEqual(fs.readFileSync(s.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type), ['a', 'b'])
  assert.equal(fs.readFileSync(s.reportPath, 'utf8'), '# laporan')
})

test('laporan: status, kesimpulan, tabel suara, klaim (karakter | di-escape), dan jalannya sidang', async () => {
  const panel = [scriptedAgent('a'), scriptedAgent('b', { PANEL: ({ round }) => ({ position: 'posisi | b', claims: [{ text: 'klaim | pipa', kind: 'estimate' }], ...(round > 1 ? { vote: { on_draft: 'AGREE_WITH_RESERVATIONS', reservations: ['perlu data BPS'] } } : {}) }) })]
  const { result } = await sampleRun(panel)
  const md = buildReport(result)
  assert.match(md, /^# The Council — Q\?/)
  assert.match(md, /\| Topik \| Ide hackathon \\\| UMKM \|/)
  assert.match(md, /\| Status \| ✔ BULAT \|/)
  assert.match(md, /\| Moderator \| A \(opus\) \|/)
  assert.match(md, /\| Panel \| A \(a-model\) = Panelis A, B \(b-model\) = Panelis B \|/)
  assert.match(md, /## Kesimpulan\n\ndraft r1\n/)
  assert.match(md, /\| B \(Panelis B\) \| ◐ setuju dengan catatan \| Catatan: perlu data BPS \|/)
  assert.match(md, /\| K\d \| klaim \\\| pipa \| estimate \| – \| · belum dicek \| B; ronde 1, 2 \|/)
  assert.match(md, /https:\/\/a\.test\/a<br>"q"/)
  assert.match(md, /### Ronde 1 \(blind\)[\s\S]*#### A \(Panelis A\) · [\d.]+ dtk[\s\S]*### Ronde 2 \(kritik\)/)
  assert.match(md, /Verifikasi sumber \| mati/)
  assert.match(md, /- Panggilan AI: 6;/)
  assert.match(md, /\| B \(panelis\) \| 2 \| 240 \| 40 \| 20 \| \$0\.0200 \|/)
  assert.match(md, /\| Rangkuman moderator \| 1 \|/)
  assert.equal(result.claims.length, 2) // klaim yang sama di ronde 2 tidak diulang
})

test('demoteHeadings menurunkan judul di luar blok kode', () => {
  assert.equal(demoteHeadings('# A\n## B\n```\n# kode\n```\n#tag bukan judul\n###### F'), '### A\n#### B\n```\n# kode\n```\n#tag bukan judul\n###### F')
})

test('laporan: judul di draft moderator tidak merusak struktur laporan', async () => {
  const judge = ({ round }) => ({ summary: 's', draft: `## Draft Kesimpulan (Ronde ${round})\n### 1. Masalah\nisi` })
  const { result } = await sampleRun([scriptedAgent('a', { JUDGE: judge }), scriptedAgent('b')])
  const md = buildReport(result)
  assert.match(md, /## Kesimpulan\n\n#### Draft Kesimpulan \(Ronde 1\)\n##### 1\. Masalah/)
  assert.doesNotMatch(md, /^## Draft/m)
})

test('laporan sidang tanpa konsensus memberi peringatan di kesimpulan', async () => {
  const no = { PANEL: ({ round }) => ({ position: 'p', ...(round > 1 ? { vote: { on_draft: 'DISAGREE' } } : {}) }), VOTE: { vote: { on_draft: 'DISAGREE', blocking_objections: ['salah hitung'] } } }
  const { result } = await sampleRun([scriptedAgent('a', no), scriptedAgent('b', no)], { maxRounds: 1 })
  const md = buildReport(result)
  assert.match(md, /✖ TIDAK ADA KONSENSUS/)
  assert.match(md, /tidak disetujui bulat/)
  assert.match(md, /\*\*Keberatan:\*\* salah hitung/)
  assert.match(md, /### Pemungutan suara akhir/)
})

test('tampilan terminal mencetak jalannya sidang seperti chat', async () => {
  const { events } = await sampleRun([scriptedAgent('a'), scriptedAgent('b')])
  let text = ''
  const out = { write: (s) => (text += s), isTTY: false }
  const r = createTerminalRenderer({ out, style: createStyle(false) })
  for (const e of events) r.handle({ ...e, ...(e.type === 'finished' ? { report: 'sessions/x/report.md' } : {}) })
  r.handle({ type: 'finished', status: 'majority', round: 3, decidedBy: 'vote', summary: '' })
  r.close()
  assert.match(text, /━━ The Council ━━\nTopik: Ide hackathon \| UMKM/)
  assert.match(text, /Panel: A \(a-model\) = Panelis A · B \(b-model\) = Panelis B/)
  assert.match(text, /\[Moderator · A\] Pertanyaan: Q\?\n  • k1/)
  assert.match(text, /── Ronde 1 \(blind\)/)
  assert.match(text, /\[B · Panelis B\] [\d.]+ dtk\n  posisi b r1\n  ▸ P1: ide b\n  klaim: K\d \(1 dengan sumber\)/)
  assert.match(text, /suara: ✔ AGREE/)
  assert.match(text, /Suara atas draft ronde 1: 2\/2 setuju → BULAT/)
  assert.match(text, /━━ Hasil: ✔ BULAT \(ronde 2\) ━━\nringkas r1\nLaporan: sessions\/x\/report\.md/)
  assert.match(text, /━━ Hasil: ◐ MAYORITAS \(suara akhir\) ━━/)
  assert.doesNotMatch(text, /menunggu:/) // baris status hanya untuk terminal interaktif
})

test('council run end-to-end lewat CLI dengan Claude palsu (--json)', async (t) => {
  const api = await startFakeApi()
  t.after(api.close)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-run-'))
  const config = {
    moderator: { agent: 'opus', model: 'opus' },
    panel: ['opus', 'haiku'],
    agents: {
      opus: { type: 'claude-cli', label: 'Claude Opus', bin: fakeBin('fake-claude.js'), model: 'opus' },
      haiku: { type: 'claude-cli', label: 'Claude Haiku', bin: fakeBin('fake-claude.js'), model: 'haiku' }
    }
  }
  fs.writeFileSync(path.join(dir, 'council.config.json'), JSON.stringify(config))
  // Asinkron (bukan spawnSync) supaya server palsu di proses ini tetap bisa menjawab verifier di proses anak.
  const run = (args, env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'src/index.js'), 'run', ...args], {
        cwd: dir,
        env: { ...process.env, FAKE_URL: `${api.url}/source`, ...env }
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })

  const ok = await run(['Ide hackathon UMKM', '--json', '--rounds', '2'])
  assert.equal(ok.status, 0, ok.stderr)
  const events = ok.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(events[0].type, 'session_started')
  assert.deepEqual(events[0].panel.map((p) => p.label), ['Claude Opus', 'Claude Haiku'])
  const last = events.at(-1)
  assert.equal(last.type, 'finished')
  assert.equal(last.status, 'unanimous')
  // Verifier sungguhan membuka halaman sumber palsu dan menemukan kutipannya.
  assert.ok(events.some((e) => e.type === 'verified'))
  assert.equal(last.verification.verified, 1)
  assert.ok(fs.existsSync(last.report))
  assert.match(fs.readFileSync(last.report, 'utf8'), /Draft kesimpulan ronde 1/)
  const saved = fs.readFileSync(path.join(path.dirname(last.report), 'events.jsonl'), 'utf8').trim().split('\n')
  assert.equal(saved.length, events.length)

  const disagree = await run(['Ide hackathon', '--json', '--rounds', '1', '--model', 'haiku=sonnet', '--no-verify'], { FAKE_CLAUDE_MODE: 'disagree' })
  assert.equal(disagree.status, 0, disagree.stderr)
  const devents = disagree.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(devents.at(-1).status, 'no_consensus')
  assert.equal(devents[0].panel[1].model, 'sonnet')

  const bad = await run(['topik', '--rounds', '0', '--model', 'gemini=x', '--search-budget=-1'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--rounds harus bilangan bulat/)
  assert.match(bad.stderr, /--model "gemini=x"/)
  assert.match(bad.stderr, /--search-budget harus/)

  assert.equal((await run([])).status, 2)
})
