# The Council — Rencana Implementasi

> Status: **Fase 1**. `council run` (debat) dan `council doctor` sudah ada. Keduanya sudah dicoba dengan Claude asli di lingkungan cloud, tapi belum di Windows. Rencana ditulis 2 Oktober 2026.
> Yang ditandai **[cek]** belum aku verifikasi langsung. Cek dulu di Fase 0 sebelum diandalkan.

## Keputusan

| # | Tanggal | Keputusan |
|---|---|---|
| K1 | 2 Okt 2026 | Claude jadi **moderator sekaligus panelis**. Model dipilih terpisah untuk tiap peran: `moderator.model` dan `agents.claude.model`. |
| K2 | 2 Okt 2026 | Panel awal: **Claude, Codex, DeepSeek**. Gemini tidak dipakai (lihat F6), tapi bisa ditambahkan nanti sebagai adapter. |
| K3 | 2 Okt 2026 | Debat dan laporan dalam **Bahasa Indonesia**. |
| K4 | 2 Okt 2026 | Fase 0 dibuat **tanpa dependensi npm**: `fetch` bawaan Node untuk DeepSeek, `process.loadEnvFile` untuk `.env`, dan warna ANSI sederhana. |
| K5 | 2 Okt 2026 | Panel boleh berisi **beberapa agen Claude dengan model berbeda** (Opus, Sonnet, Haiku), cukup dengan satu langganan Claude. Contohnya ada di `examples/claude-only.json`. |

## 1. Tujuan

Satu perintah di terminal Windows memulai "sidang" beberapa agen AI (Claude, Codex/ChatGPT, DeepSeek). Di sidang itu para agen:

1. menjawab masalah yang diberikan secara independen,
2. saling mengkritik berdasarkan data dan fakta dari internet, lengkap dengan sumbernya,
3. berputar beberapa ronde sampai semua setuju. Kalau tidak tercapai, sidang berhenti dan perbedaan pendapatnya dicatat apa adanya,
4. menghasilkan laporan akhir yang bisa dikirim lewat bot WhatsApp (`yearsky/chatbot-wa`).

Contoh:

```
council "Ide hackathon tentang keuangan UMKM yang bisa dibuat dalam 48 jam"
```

Kegunaan berikutnya (fase akhir): kolaborasi coding antar agen.

## 2. Temuan riset yang memengaruhi desain

| # | Temuan | Keyakinan | Dampak ke desain |
|---|---|---|---|
| F1 | Claude Code bisa jalan headless lewat `claude -p` dengan `--output-format json` atau `stream-json`. Flag lain yang tersedia: `--json-schema` (hasilnya di field `structured_output`), `--tools`, `--allowedTools`, `--system-prompt`, dan `--no-session-persistence`. | Tinggi (docs resmi + `claude --help` v2.1.287). Kombinasi flag di §7 sudah dicoba dengan Claude Code v2.1.287 di lingkungan cloud (Linux, bukan Windows): uji dasar dan WebSearch berhasil. | Claude dipanggil sebagai subprocess, baik sebagai moderator maupun panelis. |
| F2 | `--bare` **tidak** membaca login langganan; mode ini butuh `ANTHROPIC_API_KEY`. Menurut docs, `--bare` "will become the default for `-p` in a future release". `chatbot-wa` sudah mengalami ini (keputusan D7 di `docs/SDD.md`). | Tinggi | Jangan pakai `--bare`. Pantau rilis Claude Code: kalau default-nya berubah, adapter harus disesuaikan. |
| F3 | Docs Anthropic menyebut OAuth langganan "designed to support ordinary use of Claude Code". Batas pemakaian Pro/Max "assume ordinary, individual usage of Claude Code and the Agent SDK". Developer juga tidak boleh "route requests through Free, Pro, or Max plan credentials on behalf of their users". | Tinggi untuk isi docs-nya. Aku tidak bisa memberi pendapat hukum soal penafsirannya. | Pakai Council **untuk dirimu sendiri**, di PC-mu, dengan binary `claude` resmi. Jangan jadikan layanan untuk orang lain lewat langgananmu. Bot WA kamu sudah owner-only, jadi sejalan. Tetap baca sendiri ketentuannya. |
| F4 | Mei 2026, Anthropic mengumumkan bahwa mulai 15 Juni 2026 pemakaian `claude -p`/Agent SDK dipindah ke kredit terpisah. Rencana itu **ditunda**. Media mengutip halaman support Anthropic: "For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription's usage limits." | Sedang. Ini dari sumber sekunder; halaman support aslinya tidak aku buka. | Kebijakan ini bisa berubah lagi. Catat pemakaian tiap panggilan (`total_cost_usd` di output JSON, yang merupakan estimasi sisi klien), dan sediakan opsi API key untuk tiap agen. |
| F5 | Codex CLI bisa jalan non-interaktif lewat `codex exec`: prompt via stdin (`-`), output JSONL dengan `--json`, plus `--output-last-message`, `--sandbox read-only`, dan `--ephemeral`. `chatbot-wa` sudah memakai ini dengan login akun ChatGPT di Windows. Web search: `--search` atau `-c web_search="live"` **[cek]**. | Tinggi untuk `exec` (sudah jalan di kodemu). Sedang untuk web search: hanya dari ringkasan hasil pencarian, karena docs OpenAI tidak bisa dibuka dari lingkunganku. | Codex jadi panelis. Web search dicek di Fase 0. |
| F6 | **Gemini CLI berhenti melayani akun individu** (gratis, Google AI Pro, Ultra) sejak 18 Juni 2026; penggunanya diarahkan ke Antigravity CLI. Login dengan API key tetap jalan. Sumbernya diskusi resmi di repo `google-gemini/gemini-cli`. README Gemini CLI masih menyebut free tier login Google, kemungkinan belum diperbarui. | Tinggi untuk penghentiannya. Aku **tidak tahu** apakah Antigravity CLI punya mode headless. | Gemini tidak dipakai dulu (K2). Kalau nanti ditambahkan, pakai Gemini API key. |
| F7 | DeepSeek API memakai format OpenAI (base URL `https://api.deepseek.com`) dan dibayar per token. Nama model saat ini **[cek]**: sumber sekunder menyebut `deepseek-v4-flash` dan `deepseek-v4-pro`, tapi docs resmi tidak bisa aku buka. Aku juga tidak menemukan bukti ada web search bawaan di API-nya **[cek]**. | Sedang | Dipanggil dengan `fetch` bawaan Node (K4). Nama model diambil dari config dan dicek lewat `GET /models` di `council doctor`. Untuk data internet, DeepSeek perlu dibantu (lihat §6). |
| F8 | Pola serupa sudah ada: **llm-council** (Andrej Karpathy). Alurnya: jawaban awal paralel, lalu peer review **anonim** (supaya model tidak pilih kasih), lalu "Chairman" menyusun jawaban akhir. Bedanya, itu web app lewat OpenRouter (API), bukan CLI berlangganan, dan tidak mewajibkan konsensus. | Sedang (dari artikel, bukan dari repo-nya langsung) | Pinjam ide anonimisasi dan moderator/chairman. |
| F9 | `chatbot-wa/src/ai/cli.js` sudah menangani jebakan Windows: CLI `.cmd` butuh `shell`, argumen di-quote manual, prompt dikirim lewat stdin, dan `taskkill /T /F` untuk mematikan seluruh pohon proses. Ada juga pola test `fakeBin()` yang membungkus fixture jadi `.cmd`. | Tinggi (kodenya aku baca langsung) | **Salin dan pakai ulang**, jangan tulis ulang. |
| F10 | Claude Code v2.1.287 punya flag `--restricted`, yang antara lain mengabaikan file settings user/project/local. Di uji coba cloud, login tetap jalan, tapi plugin **tetap termuat** dengan flag itu. Di Windows mungkin hasilnya berbeda. | Sedang (satu uji coba, bukan di Windows) | Tidak dipakai secara bawaan. Doctor menampilkan plugin/MCP yang ikut termuat sebagai info. `--restricted` bisa dicoba lewat `extraArgs`. |

## 3. Asumsi (koreksi kalau salah)

- "DeepSeek APK" = **API key** DeepSeek, bukan aplikasi Android.
- Jalan di PC Windows 11 milikmu dengan Node.js ≥ 22. Menurut SDD `chatbot-wa`, kamu sudah pakai v22. Login `claude` dan `codex` sudah dilakukan.
- Dipakai pribadi, oleh satu orang.

## 4. Arsitektur

```
        kamu (terminal Windows / WhatsApp / /council di Claude Code)
                              │ topik
                              ▼
                 ┌──────────────────────────┐
                 │  council engine (Node)   │  state machine debat
                 └─────┬────────┬────────┬──┘
     event JSONL       │        │        │   paralel per ronde
  ┌─────────────┐ ┌────▼───┐ ┌──▼────┐ ┌─▼────────┐
  │ terminal /  │ │ Claude │ │ Codex │ │ DeepSeek │
  │ bot WA /    │ │ claude │ │ codex │ │ API      │
  │ Claude Code │ │ -p     │ │ exec  │ │ (fetch)  │
  └─────────────┘ └────────┘ └───────┘ └──────────┘
                 ┌──────────────────────────┐
                 │ verifier sumber (kode)   │  fetch URL + cek kutipan
                 └──────────────────────────┘
```

Prinsip:

1. **Engine headless.** Engine tidak mengurus tampilan. Semua kejadian dipancarkan sebagai event. Terminal, WhatsApp, dan Claude Code membaca event yang sama.
2. **Tiap panggilan berdiri sendiri.** Setiap panggilan agen membawa konteks lengkap (topik + ringkasan ronde sebelumnya) di prompt, tanpa bergantung pada sesi CLI (`--resume`). Hasilnya lebih mudah dites dan diulang. Optimasi bisa menyusul.
3. **Agen hanya berpendapat, kode yang memutuskan.** Prinsipnya sama dengan D3 di `chatbot-wa`: penghitungan suara, pengecekan sumber, dan keputusan berhenti dilakukan kode, bukan berdasarkan klaim model.
4. **Adapter seragam.** Menambah agen baru cukup dengan menambah satu file adapter.

```js
// Kontrak adapter (versi Fase 0, src/agents/)
{
  id: 'codex',
  label: 'Codex',
  type: 'codex-cli',
  model: '',
  capabilities: { webSearch: true },
  async ask({ system, prompt, webSearch, model, timeoutMs }) {
    // → { text, usage?, costUsd?, meta?: { model, tools, plugins, mcpServers, toolUses } }
  },
  version(),              // agen CLI: string versi atau null
  hasKey(), listModels()  // agen API
}
```

Streaming (`onDelta`) dan pembatalan (`signal`) ditambahkan di Fase 3.

## 5. Protokol debat

```
FRAME ─▶ RONDE 1 (blind) ─▶ VERIFY ─▶ JUDGE ─┬─▶ RONDE n (kritik) ─▶ VERIFY ─▶ JUDGE ─┐
moderator  panelis paralel    kode   moderator │    panelis paralel                    │
                                               └─────── ulang ≤ maxRounds ◀────────────┘
                                                              │ konsensus / batas ronde
                                                              ▼
                                                   VOTE AKHIR ─▶ LAPORAN
```

1. **FRAME (moderator = Claude).** Permintaanmu diubah jadi pertanyaan yang jelas plus kriteria keberhasilan. Contoh untuk ide hackathon: bisa dibangun dalam 48 jam, ada data yang menunjukkan masalahnya nyata, dan berbeda dari yang sudah ada. Hasil framing ditampilkan dulu; dengan opsi `--confirm`, kamu bisa mengeditnya sebelum lanjut.
2. **RONDE 1 (blind).** Semua panelis menjawab **paralel tanpa melihat jawaban yang lain**, supaya tidak ikut-ikutan. Setiap jawaban wajib menyertakan klaim beserta sumbernya.
3. **VERIFY (dilakukan kode, bukan AI).** Setiap sumber dicek (lihat §6).
4. **JUDGE (moderator).** Moderator merangkum poin yang disepakati dan yang diperdebatkan, menyusun *draft* kesimpulan, lalu menentukan pertanyaan untuk ronde berikutnya.
5. **RONDE n (kritik).** Panelis melihat jawaban panelis lain yang **dianonimkan** (Panelis A/B/C, urutan diacak), hasil verifikasi, dan draft moderator. Lalu mereka mengkritik, merevisi posisinya, dan **memberi suara** atas draft.
6. **Berhenti** kalau semua panelis memilih `AGREE` tanpa keberatan pemblokir, atau kalau `maxRounds` (default 3) sudah tercapai.
7. **LAPORAN** berisi: kesimpulan, alasannya, tabel klaim dengan status verifikasinya, **perbedaan pendapat yang masih tersisa**, dan pemakaian kuota/biaya.

### Format jawaban panelis (JSON, divalidasi kode)

```json
{
  "position": "posisi ringkas",
  "proposals": [{ "id": "P1", "title": "...", "why": "..." }],
  "claims": [
    {
      "id": "C1",
      "text": "...",
      "kind": "fact | estimate | opinion",
      "source_url": "https://...",
      "quote": "kutipan persis dari sumber"
    }
  ],
  "critiques": [{ "target": "B", "point": "...", "severity": "blocking | minor" }],
  "changed_mind": { "changed": true, "what": "...", "because": "C4 dari Panelis B" },
  "vote": { "on_draft": "AGREE | AGREE_WITH_RESERVATIONS | DISAGREE", "blocking_objections": [] }
}
```

Output Claude bisa dipaksa mengikuti skema ini lewat `--json-schema`, tapi skema JSON penuh tanda kutip, dan argumen di Windows melewati cmd.exe. Jadi di Fase 1 cara ini dites dulu di Windows. Kalau bermasalah, Claude diperlakukan sama seperti agen lain. Untuk agen lain alurnya: minta JSON di prompt, parse, lalu validasi. Kalau gagal, agen diminta memperbaiki satu kali. Kalau masih gagal, agen itu dianggap gagal di ronde tersebut, dan debat tetap jalan.

### Aturan anti "setuju palsu"

Model bahasa cenderung mengalah ke pendapat yang lain, jadi "semua setuju" bisa terjadi tanpa alasan yang kuat. Karena itu:

- Ronde 1 selalu blind, dan identitas panelis dianonimkan di ronde kritik.
- Panelis yang berganti posisi **wajib** menyebut bukti yang membuatnya berubah (`changed_mind.because`). Pergantian posisi tanpa alasan akan ditandai di laporan.
- Di tiap ronde, satu panelis bergiliran menjadi **devil's advocate** yang wajib mencari kelemahan draft.
- Klaim berstatus ❌ atau ⚠️ tidak boleh dijadikan dasar kesimpulan.
- Kalau batas ronde habis, laporan diberi status **"tidak bulat"**, berisi posisi mayoritas dan pendapat yang berbeda. Konsensus tidak dipaksakan. Kalau mau, tersedia mode `--consensus majority`.

## 6. Data & fakta

- **Agen yang punya web search sendiri:** Claude (`WebSearch`, `WebFetch`) dan Codex (**[cek]**).
- **DeepSeek tidak punya web search bawaan [cek].** Ada dua opsi, dipilih di Fase 2:
  - a. **Paket bukti** (default). DeepSeek menerima semua sumber terverifikasi dari agen lain dan berperan sebagai *skeptic*, yaitu pemeriksa logika dan konsistensi. Ini yang paling sederhana dan tanpa biaya tambahan.
  - b. **Tool pencarian.** Orchestrator memberi DeepSeek function calling ke API pencarian, misalnya Brave atau Tavily. Ini butuh API key tambahan.
- **Verifier sumber (kode).** Untuk setiap klaim `fact`: fetch URL, cek status HTTP, lalu cari `quote` di teks halaman (setelah dinormalisasi). Hasilnya:
  - ✅ terverifikasi,
  - ⚠️ halaman ada tapi kutipannya tidak ditemukan,
  - ❌ halaman tidak bisa diakses.

  Banyak situs memblokir bot atau baru tampil setelah JavaScript jalan. Halaman seperti itu dicatat "tidak bisa dicek", bukan "salah".
- **Konten web diperlakukan sebagai data, bukan instruksi.** Ini untuk mencegah prompt injection.

## 7. Adapter per agen

| Agen | Cara panggil | Akun | Web search | Status |
|---|---|---|---|---|
| Claude (moderator + panelis) | `claude -p --output-format stream-json --verbose --no-session-persistence --permission-mode dontAsk --system-prompt <prompt> --model <model> [--allowedTools WebSearch,WebFetch] --tools <WebSearch,WebFetch atau "">`. Prompt dikirim lewat stdin, cwd = folder kosong. `stream-json` dipakai supaya event `init` (model, tool, plugin) dan pemanggilan tool bisa dibaca. | Langganan Claude Pro (tanpa `--bare`) | Ya | Sudah dicoba dengan v2.1.287 di cloud (Linux); belum dites di Windows. |
| Codex | `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never --output-last-message <file> [-c web_search="live"] -` | Akun ChatGPT | **[cek]** | `exec` sudah jalan di `chatbot-wa`. |
| DeepSeek | `fetch` ke `https://api.deepseek.com/chat/completions` (format OpenAI) dengan `DEEPSEEK_API_KEY` | API key, bayar per token | Tidak **[cek]** | Nama model **[cek]**. |

Pelajaran dari `chatbot-wa` yang wajib dibawa:

- Claude diberi `--system-prompt` sendiri. Prompt bawaan Claude Code ("asisten software engineering") bisa membuat model menolak tugas non-coding (D5 di SDD).
- Prompt selalu dikirim lewat stdin. `killTree` di Windows memakai `taskkill /T /F`.
- Dalam satu ronde, panelis dipanggil paralel dengan `Promise.allSettled` dan timeout per agen, sehingga satu agen yang gagal tidak menggagalkan seluruh ronde.

## 8. Tampilan terminal

Fase 1, sederhana seperti chat:

```
━━ The Council ━━ topik: Ide hackathon keuangan UMKM (48 jam)
[Moderator·Claude] Pertanyaan: ... Kriteria: ...
── Ronde 1 (blind) ──────────── Claude ✔ 41s · Codex ⠋ 33s · DeepSeek ✔ 12s
[Codex]    Usul: ... (3 klaim, 2 sumber)
[DeepSeek] Usul: ...
[Verifier] 5 klaim: ✅3 ⚠️1 ❌1
[Moderator·Claude] Setuju: ... | Berbeda: ... | Draft v1: ...
── Ronde 2 (kritik) ── ...
━━ Hasil: BULAT ✅ (ronde 2) · laporan: sessions/2026-10-02_1530_ide-hackathon/report.md
```

- Jawaban agen ditampilkan utuh begitu agen selesai, bukan token per token, supaya output paralel tidak bercampur. Baris status menunjukkan agen mana yang masih berpikir.
- Fase 3 menambahkan opsi `--panes`. Opsi ini membuka panel Windows Terminal (`wt split-pane`), masing-masing menampilkan log streaming satu agen (`Get-Content -Wait sessions/.../codex.log`). Sintaks `wt` **[cek]**. Hasilnya, tiap agen terlihat seperti punya terminal sendiri, tanpa perlu mengendalikan TUI interaktif tiap CLI (cara itu rapuh).

## 9. Struktur repo

```
thecouncil/
├─ package.json                # "type": "module", bin: council
├─ .env.example                # DEEPSEEK_API_KEY=
├─ .gitignore                  # .env, council.config.json, sessions/
├─ council.config.example.json
├─ src/
│  ├─ index.js                 # CLI: council run | doctor | replay
│  ├─ config.js
│  ├─ doctor.js                # Fase 0: cek tiap agen
│  ├─ agents/
│  │  ├─ cli.js                # disalin dari chatbot-wa/src/ai/cli.js
│  │  ├─ claude.js             # pola dari chatbot-wa/src/ai/claudeCli.js
│  │  ├─ codex.js              # pola dari chatbot-wa/src/ai/codexCli.js
│  │  ├─ openaiCompat.js       # DeepSeek + provider lain yang kompatibel OpenAI
│  │  └─ index.js              # registry agen dari config
│  ├─ council/
│  │  ├─ protocol.js           # state machine FRAME → RONDE → JUDGE → LAPORAN
│  │  ├─ prompts.js            # prompt moderator, panelis, devil's advocate
│  │  ├─ schema.js             # skema JSON + validasi + permintaan perbaikan
│  │  ├─ consensus.js          # hitung suara, kondisi berhenti
│  │  └─ anonymize.js
│  ├─ evidence/verify.js       # fetch URL + cek kutipan
│  ├─ ui/style.js              # warna ANSI
│  ├─ ui/terminal.js           # tampilan chat berwarna + baris status
│  ├─ ui/panes.js              # opsional: wt split-pane
│  └─ store/session.js         # sessions/<waktu>_<slug>/events.jsonl, report.md, <agen>.log
├─ test/
│  ├─ helpers.js               # fakeBin() dari chatbot-wa
│  ├─ fixtures/                # fake-claude.js, fake-codex.js, ...
│  └─ *.test.js                # protocol, consensus, verify, schema, adapters
├─ .claude/skills/council/SKILL.md   # /council dari dalam Claude Code
└─ docs/PLAN.md
```

Gaya kode mengikuti `chatbot-wa`: JavaScript ESM tanpa build step, test dengan `node --test`, dependensi seminimal mungkin. Sampai Fase 0 belum ada dependensi npm sama sekali (K4).

Config yang dipakai ada di `council.config.example.json`. Intinya:

```json
{
  "moderator": { "agent": "claude", "model": "sonnet" },
  "panel": ["claude", "codex", "deepseek"],
  "maxRounds": 3,
  "consensus": "unanimous",
  "agents": {
    "claude": { "type": "claude-cli", "model": "sonnet" },
    "codex": { "type": "codex-cli", "model": "", "webSearchArgs": ["-c", "web_search=live"] },
    "deepseek": { "type": "openai-compatible", "baseURL": "https://api.deepseek.com", "model": "", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  }
}
```

`moderator.model` dan `agents.claude.model` boleh berbeda (K1), misalnya moderator `opus` dan panelis `sonnet`.

## 10. Kontrak event (untuk terminal, WhatsApp, dan Claude Code)

`council run --json "<topik>"` mencetak satu event JSON per baris ke stdout:

```
{"type":"session_started","ts":"...","topic":"...","panel":[{"id":"claude","label":"Claude","model":"sonnet"}],"moderator":{"id":"claude","label":"Claude","model":"opus"},"maxRounds":3,"consensus":"unanimous","web":true}
{"type":"framed","ts":"...","question":"...","criteria":["..."],"context":"..."}
{"type":"round_started","ts":"...","round":1,"mode":"blind|critique|vote"}
{"type":"agent_started","ts":"...","round":1,"agent":"codex"}
{"type":"agent_finished","ts":"...","round":1,"agent":"codex","ms":33000,"repaired":false,"response":{"position":"...","proposals":[],"claims":[],"critiques":[],"changed_mind":{},"vote":{}}}
{"type":"agent_failed","ts":"...","round":1,"agent":"deepseek","ms":180000,"error":"..."}
{"type":"judged","ts":"...","round":1,"summary":"...","agreements":["..."],"disagreements":["..."],"draft":"...","next_focus":"..."}
{"type":"votes","ts":"...","round":2,"draftRound":1,"status":"majority","accepted":["claude","codex"],"rejected":["deepseek"],"total":3,"votes":{},"final":true}
{"type":"warning","ts":"...","stage":"frame|panel|judge","message":"..."}
{"type":"finished","ts":"...","status":"unanimous|majority|no_consensus|error","round":2,"summary":"...","draft":"...","usage":{"calls":8},"session":"...","report":"/.../report.md"}
```

Catatan:

- `response` di `agent_finished` berisi jawaban panelis yang sudah divalidasi (format di §5). Di pemungutan suara akhir isinya hanya `{"vote": ...}`.
- `final: true` hanya muncul pada `votes` dari pemungutan suara akhir.
- Event `verified` (hasil verifier sumber) ditambahkan di Fase 2.
- Semua event juga disimpan di `sessions/<id>/events.jsonl`.

Ini kontrak antar-repo, jadi perubahannya harus tetap kompatibel ke belakang: menambah field boleh, mengganti nama field jangan.

## 11. Integrasi WhatsApp (`chatbot-wa`)

- Tambah perintah `/council <topik>` di `src/commands.js`, atau sebagai intent baru di `src/assistant.js`.
- Bot menjalankan `council run --json` sebagai subprocess memakai `runCli`/`spawnCli` yang sudah ada, lalu membaca event baris per baris:
  - kirim "🏛️ Sidang dimulai…" saat `session_started`,
  - kirim ringkasan per ronde (opsional, bisa dimatikan supaya tidak spam),
  - kirim hasil akhir (`summary`, status, dan jumlah klaim terverifikasi). Pesan yang panjang dipecah.
- Hanya satu sidang dalam satu waktu (antrian). Timeout total bisa diatur. `/council stop` membatalkan sidang (pakai `killTree`).
- Bot dan Council jalan di PC yang sama, jadi login `claude` dan `codex` dipakai bersama. Konsekuensinya, PC harus menyala.
- Bot tetap owner-only (lihat F3).

## 12. Keamanan

- Dalam mode debat, agen **tidak boleh menulis file atau menjalankan shell**. Claude dibatasi lewat `--tools` (hanya `WebSearch` dan `WebFetch`), Codex lewat `--sandbox read-only`. Working directory-nya folder sesi yang kosong, bukan folder proyekmu.
- API key hanya disimpan di `.env`, yang masuk `.gitignore`. Folder `sessions/` juga di-ignore karena bisa berisi data pribadi.
- Konten web diperlakukan sebagai data, bukan instruksi. Verifikasi sumber dilakukan oleh kode.
- Mode coding (Fase 5) baru boleh menulis file, dan hanya di git worktree terpisah.

## 13. Fase pengerjaan

Fase dianggap selesai kalau kriteria "Selesai bila" terpenuhi. Aku tidak memberi estimasi waktu karena banyak yang bergantung pada hasil Fase 0.

### Fase 0 — Uji coba & `council doctor`

**Status:** kode selesai (`src/doctor.js`, adapter di `src/agents/`, 21 test dengan agen palsu). Claude sudah dicoba dengan CLI asli di lingkungan cloud. **Menunggu dijalankan di Windows.**

- `council doctor` memeriksa tiap agen:
  - Claude/Codex: terpasang (`--version`).
  - DeepSeek: API key terisi dan `GET /models`.
  - Uji dasar ("SIAP"), termasuk model moderator Claude kalau berbeda.
  - Uji web search (pertanyaan yang butuh data terbaru): URL di jawaban dibuka untuk dicek. Untuk Claude, juga dicek apakah tool `WebSearch` benar-benar dipanggil.
- Yang harus dipastikan di Windows:
  - Claude `-p` jalan dengan login langganan, termasuk `WebSearch`.
  - Web search Codex jalan; kalau `-c web_search=live` gagal, coba `["--search"]` di `webSearchArgs`.
  - DeepSeek `GET /models` mengembalikan nama model; pilih satu untuk config.
- **Selesai bila:** `council doctor` di Windows menunjukkan ketiga agen ✔ (DeepSeek tanpa web search), dan Claude serta Codex bisa menjawab pertanyaan yang butuh internet, lengkap dengan URL sumber.

### Fase 1 — MVP debat

- Adapter Claude, Codex, dan DeepSeek. Protokol FRAME → ronde blind → JUDGE → ronde kritik → vote. Skema + validasi, tampilan terminal sederhana, penyimpanan sesi + `report.md`.
- Test dengan agen palsu (`fakeBin`), termasuk lewat `.cmd` di Windows. Skenario yang dites: agen timeout, JSON rusak, semua setuju di ronde 1, dan tidak pernah setuju.
- **Selesai bila:** `council run "ide hackathon ..."` selesai dengan sendirinya dengan status `unanimous`, `majority`, atau `no_consensus`, dan laporannya bisa dibaca.

### Fase 2 — Data & fakta

- Klaim + verifier sumber, anonimisasi, devil's advocate, aturan "ganti posisi harus ada buktinya", dan paket bukti untuk DeepSeek.
- **Selesai bila:** laporan memuat tabel klaim dengan status ✅/⚠️/❌, dan kesimpulannya tidak bergantung pada klaim ❌.

### Fase 3 — Pengalaman terminal

- Status live, streaming ke `<agen>.log`, opsi `--panes` (Windows Terminal), `council replay <sesi>`, dan skill `/council` untuk Claude Code.
- **Selesai bila:** satu sidang bisa ditonton per agen di panel terpisah, dan `/council <topik>` dari Claude Code menampilkan ringkasan hasilnya.

### Fase 4 — WhatsApp

- Perintah `/council` di `chatbot-wa` (lihat §11).
- **Selesai bila:** mengirim `/council <topik>` dari WhatsApp menghasilkan notifikasi mulai dan hasil akhir, dan `/council stop` bisa membatalkan sidang.

### Fase 5 — Kolaborasi coding (desainnya menyusul)

- Ide awal: moderator memecah tugas, satu agen mengimplementasi di git worktree-nya sendiri, agen lain me-review diff-nya, dan test jadi "hakim" yang objektif. Desain detailnya dibuat setelah Fase 1–2 terbukti jalan.

## 14. Risiko

| Risiko | Mitigasi |
|---|---|
| Kuota langganan cepat habis. Satu sidang berarti banyak panggilan, dan Claude dipakai sebagai moderator sekaligus panelis. | Batasi `maxRounds`, pakai model yang lebih ringan untuk panelis, ringkas konteks antar ronde, tampilkan pemakaian tiap sidang, dan sediakan opsi moderator yang tidak ikut jadi panelis. Angka kuota pastinya tidak aku ketahui. |
| Kebijakan atau harga berubah. F2, F4, dan F6 menunjukkan perubahan bisa terjadi cepat. | Adapter terisolasi. Tiap agen bisa dipindah ke API key lewat config. Jalankan `council doctor` secara rutin. |
| Konsensus palsu. | Aturan di §5. |
| Sumber hasil halusinasi. | Verifier di §6; klaim ❌ tidak dipakai. |
| Masalah khas Windows (quoting, `.cmd`, proses yatim). | Pakai ulang `cli.js` dari `chatbot-wa` dan test lewat `.cmd`. |
| Prompt injection dari konten web. | Agen tidak punya tool tulis atau shell; verifikasi dilakukan kode. |
| Lama: satu sidang bisa makan beberapa menit. | Event progres; di WhatsApp, prosesnya asinkron. |

## 15. Pertanyaan terbuka

Sudah dijawab: peran Claude (K1), Gemini (K2), dan bahasa (K3).

Masih terbuka:

1. Untuk DeepSeek, cukup "paket bukti" (default), atau kamu mau API pencarian tambahan? Diputuskan sebelum Fase 2.
2. `chatbot-wa` memanggil `thecouncil` sebagai subprocess (rekomendasiku), atau meng-import-nya sebagai library? Diputuskan sebelum Fase 4.

## 16. Sumber

Dibaca langsung:

- Claude Code, *Run Claude Code programmatically*: https://code.claude.com/docs/en/headless
- Claude Code, *Legal and compliance*: https://code.claude.com/docs/en/legal-and-compliance
- Gemini CLI, diskusi resmi tentang penghentian akun individu: https://github.com/google-gemini/gemini-cli/discussions/28017
- Gemini CLI README (kemungkinan belum diperbarui): https://github.com/google-gemini/gemini-cli
- Kode `yearsky/chatbot-wa`: `src/ai/cli.js`, `src/ai/claudeCli.js`, `src/ai/claudeSession.js`, `src/ai/codexCli.js`, `docs/SDD.md`, `test/helpers.js`
- `claude --help` (v2.1.287)

Hanya dari hasil pencarian, halamannya belum aku buka (cek sendiri):

- Penundaan perubahan billing Agent SDK: https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/ dan https://devops.com/anthropic-hits-pause-on-claude-agent-sdk-billing-change-for-now/
- Codex, mode non-interaktif: https://developers.openai.com/codex/noninteractive. Konfigurasi web search: https://developers.openai.com/codex/config-basic
- DeepSeek API (sumber sekunder): https://www.morphllm.com/deepseek-api. Docs resmi: https://api-docs.deepseek.com
- llm-council (Karpathy): https://www.analyticsvidhya.com/blog/2025/12/llm-council-by-andrej-karpathy/
