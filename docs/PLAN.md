# The Council — Rencana Implementasi

> Status: **Fase 3**. `council run` (debat dengan verifikasi sumber), `council doctor`, `council ui` (UI web lokal), dan mode server di Vercel dengan DeepSeek (§18) sudah ada. `run` dan `doctor` sudah dicoba dengan Claude asli di lingkungan cloud, tapi belum di Windows. Mode server baru diuji dengan server palsu: belum dengan DeepSeek, Upstash, atau Vercel asli. Rencana ditulis 2 Oktober 2026, diperbarui 3 Oktober 2026.
> Yang ditandai **[cek]** belum aku verifikasi langsung. Cek dulu di Fase 0 sebelum diandalkan.

## Keputusan

| # | Tanggal | Keputusan |
|---|---|---|
| K1 | 2 Okt 2026 | Claude jadi **moderator sekaligus panelis**. Model dipilih terpisah untuk tiap peran: `moderator.model` dan `agents.claude.model`. |
| K2 | 2 Okt 2026 | Panel awal: **Claude, Codex, DeepSeek**. Gemini tidak dipakai (lihat F6), tapi bisa ditambahkan nanti sebagai adapter. |
| K3 | 2 Okt 2026 | Debat dan laporan dalam **Bahasa Indonesia**. |
| K4 | 2 Okt 2026 | Fase 0 dibuat **tanpa dependensi npm**: `fetch` bawaan Node untuk DeepSeek, `process.loadEnvFile` untuk `.env`, dan warna ANSI sederhana. |
| K5 | 2 Okt 2026 | Panel boleh berisi **beberapa agen Claude dengan model berbeda** (Opus, Sonnet, Haiku), cukup dengan satu langganan Claude. Contohnya ada di `examples/claude-only.json`. |
| K6 | 2 Okt 2026 | Hemat token **tanpa memotong atau meringkas isi debat**, karena memotong bisa menimbulkan bias. Penghematan hanya lewat: tidak mengulang isi, mengukur pemakaian, dan pengaturan yang tidak mengubah isi (§16). |
| K7 | 3 Okt 2026 | **Mode server (Vercel) hanya memakai agen API** yang dibayar per token (DeepSeek). Claude dan Codex lewat login langganan tetap hanya di PC sendiri (`council run`, `council ui`), sesuai F3. |
| K8 | 3 Okt 2026 | **Mode sesi: fresh + memori sidang.** Tiap panggilan tetap berdiri sendiri; tidak ada sesi permanen per agen dan tidak ada compact otomatis (compact = meringkas, bertentangan dengan K6). Kesinambungan lewat memori sidang yang dipilih eksplisit: kesimpulan + klaim ✅ sidang lama, dibawa apa adanya (§18). |
| K9 | 3 Okt 2026 | Sidang di server **dijeda kalau tidak ada yang membuka**, lalu lanjut sendiri saat dibuka lagi (browser atau bot). Tidak memakai Vercel Workflow, supaya tetap tanpa framework. |

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
| F7 | DeepSeek API dibayar per token dan punya dua format: OpenAI (`https://api.deepseek.com`) dan Anthropic (`https://api.deepseek.com/anthropic`). Endpoint OpenAI tidak bisa browsing sendiri. Endpoint Anthropic punya **web search di sisi server** (tool `web_search_20250305`, blok `server_tool_use`/`web_search_tool_result`), menurut docs DeepSeek yang dikutip di issue opencode #32273 **[cek]**. Nama model **[cek]**: sumber sekunder menyebut keluarga V4 dan bahwa `deepseek-chat`/`deepseek-reasoner` sudah dipensiunkan, tapi nama persisnya berbeda antar-sumber (`deepseek-flash` vs `deepseek-v4-flash`). | Sedang. Docs resmi DeepSeek diblokir proxy di lingkunganku, jadi semuanya dari sumber sekunder atau kutipan. | Sejak Fase 3, agen `deepseek` bawaan memakai endpoint Anthropic (`src/agents/anthropicCompat.js`) supaya bisa web search. Kalau endpoint menolak tool-nya, agen menjawab tanpa pencarian dan doctor memberi peringatan. Nama model dipilih dari `GET /models`. |
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
│  │  ├─ openaiCompat.js       # provider yang kompatibel OpenAI (daftar model DeepSeek)
│  │  ├─ anthropicCompat.js    # DeepSeek lewat format Anthropic + web search di sisi server (Fase 3)
│  │  └─ index.js              # registry agen dari config
│  ├─ council/
│  │  ├─ protocol.js           # state machine FRAME → RONDE → JUDGE → LAPORAN
│  │  ├─ prompts.js            # prompt moderator, panelis, devil's advocate
│  │  ├─ schema.js             # skema JSON + validasi + permintaan perbaikan
│  │  ├─ consensus.js          # hitung suara, kondisi berhenti
│  │  ├─ memory.js             # memori sidang untuk "lanjutkan" (Fase 3)
│  │  └─ anonymize.js
│  ├─ cloud/                   # Fase 3, §18: app.js (API), runner.js + journal.js (sidang dicicil),
│  │                           #   auth.js, config.js, seed.js
│  ├─ server.js                # `council ui`: server lokal untuk API + public/
│  ├─ evidence/verify.js       # fetch URL + cek kutipan
│  ├─ ui/style.js              # warna ANSI
│  ├─ ui/terminal.js           # tampilan chat berwarna + baris status
│  ├─ ui/panes.js              # opsional: wt split-pane
│  ├─ store/session.js         # sessions/<waktu>_<slug>/events.jsonl, report.md, memory.json
│  └─ store/kv.js              # memoryKv (lokal/test) dan upstashKv (REST, Vercel)
├─ api/index.js                # fungsi Vercel untuk /api/*
├─ public/                     # UI web: index.html, app.js, style.css
├─ vercel.json
├─ test/
│  ├─ helpers.js               # fakeBin() dari chatbot-wa
│  ├─ fixtures/                # fake-claude.js, fake-codex.js, ...
│  └─ *.test.js                # protocol, consensus, verify, schema, adapters
├─ .claude/skills/council/SKILL.md   # /council dari dalam Claude Code
└─ docs/PLAN.md
```

Gaya kode mengikuti `chatbot-wa`: JavaScript ESM tanpa build step, test dengan `node --test`, dependensi seminimal mungkin. CLI tetap tanpa dependensi npm (K4). Satu-satunya dependensi, `@vercel/functions` (untuk `waitUntil` dan `getDeadline`), hanya di-import oleh `api/index.js`.

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
    "deepseek": { "type": "anthropic-compatible", "baseURL": "https://api.deepseek.com/anthropic", "modelsURL": "https://api.deepseek.com", "model": "", "apiKeyEnv": "DEEPSEEK_API_KEY", "maxTokens": 32000 }
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
{"type":"finished","ts":"...","status":"unanimous|majority|no_consensus|error","round":2,"decidedBy":"critique|vote|null","summary":"...","draft":"...","usage":{"calls":8},"session":"...","report":"/.../report.md"}
```

Catatan:

- `response` di `agent_finished` berisi jawaban panelis yang sudah divalidasi (format di §5). Di pemungutan suara akhir isinya hanya `{"vote": ...}`.
- `final: true` hanya muncul pada `votes` dari pemungutan suara akhir.
- Event `verified` (hasil verifier sumber) ditambahkan di Fase 2.
- Fase 3:
  - `session_started` mendapat `memory` (sidang yang dilanjutkan) dan `memoryClaims` (klaim ✅ yang dibawa), hanya kalau ada memori.
  - Event baru `cancelled` (mode server).
  - Di mode server, setiap event yang disimpan mendapat `seq` (nomor urut) dan `id` (tetap per kejadian, mis. `agent_finished:2:deepseek-pro:`). `finished` membawa `run` (ID sidang) sebagai ganti `session`/`report`.
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

**Alternatif sejak Fase 3: lewat API di Vercel** (§18), kalau semua agen DeepSeek. Bot tidak perlu menjalankan apa pun selain HTTP:

- `POST /api/runs` dengan header `Authorization: Bearer <COUNCIL_API_TOKEN>` dan body `{"topic": "...", "models": {...}}`.
- Panggil `GET /api/runs/<id>/events/<n>` berkala. Setiap panggilan sekaligus melanjutkan sidang yang dijeda (K9), jadi bot yang menunggu hasil juga yang menggerakkan sidang.
- Hasil akhir ada di event `finished`; laporan lengkap di `GET /api/runs/<id>/report`.
- Batal: `POST /api/runs/<id>/cancel`.

## 12. Keamanan

- Dalam mode debat, agen **tidak boleh menulis file atau menjalankan shell**. Claude dibatasi lewat `--tools` (hanya `WebSearch` dan `WebFetch`), Codex lewat `--sandbox read-only`. Working directory-nya folder sesi yang kosong, bukan folder proyekmu.
- API key hanya disimpan di `.env`, yang masuk `.gitignore`. Folder `sessions/` juga di-ignore karena bisa berisi data pribadi.
- Konten web diperlakukan sebagai data, bukan instruksi. Verifikasi sumber dilakukan oleh kode.
- Mode coding (Fase 5) baru boleh menulis file, dan hanya di git worktree terpisah.
- **Mode server (§18):**
  - Domain produksi Vercel paket Hobby bisa dibuka siapa saja (Deployment Protection standar tidak melindunginya, menurut hasil pencarian **[cek]**). Karena itu semua API kecuali `health`, `me`, dan `login` wajib login.
  - Login: satu password (`COUNCIL_PASSWORD`), dibandingkan secara waktu-konstan, lalu cookie HttpOnly bertanda tangan HMAC berlaku 30 hari. Setelah 10 kali salah dari IP yang sama, login dikunci 15 menit.
  - Bot memakai token terpisah (`COUNCIL_API_TOKEN`).
  - Tanpa `COUNCIL_PASSWORD`, server menolak semua sidang.
  - Batas sidang per hari (bawaan 10) dan hanya satu sidang berjalan pada satu waktu, supaya saldo DeepSeek tidak terkuras.
  - API key DeepSeek dan token Redis hanya ada di env Vercel; tidak pernah dikirim ke browser atau disimpan di config sidang.
  - Agen CLI (login langganan) ditolak di server (K7).

## 13. Fase pengerjaan

Fase dianggap selesai kalau kriteria "Selesai bila" terpenuhi. Aku tidak memberi estimasi waktu karena banyak yang bergantung pada hasil Fase 0.

### Fase 0 — Uji coba & `council doctor`

**Status:** kode selesai (`src/doctor.js`, adapter di `src/agents/`). Doctor sudah dijalankan dengan Claude asli di lingkungan cloud (login OAuth langganan):

- Alias `opus`, `sonnet`, dan `haiku` masing-masing jalan sebagai claude-opus-5-5, claude-sonnet-5-5, dan claude-haiku-4-5-20251001.
- Opus dan Sonnet lolos uji web search.
- Haiku menjawab "Node.js 26 sudah LTS", berbeda dari dua model lainnya, dan URL sumbernya ditolak server (HTTP 403).

**Menunggu dijalankan di Windows.**

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

**Status:** selesai dan sudah dicoba sungguhan dengan Claude di lingkungan cloud. Belum diuji di Windows, dan belum diuji dengan Codex maupun DeepSeek asli.

- Kode:
  - `src/council/`: protokol, prompt, skema dan perbaikan JSON, penghitungan suara, laporan.
  - `src/ui/terminal.js`, `src/store/session.js`.
  - `council run` beserta opsinya.
- Test dengan agen palsu, baik di dalam proses maupun lewat CLI. Skenario: bulat di ronde 2, tidak pernah sepakat, mode mayoritas, JSON rusak lalu diperbaiki atau tetap rusak, panelis gagal lalu pulih, semua panelis gagal, moderator gagal merumuskan, dan pengaturan web search.
- **Uji sungguhan** (2 Okt 2026): `examples/claude-only.json` (Opus, Sonnet, Haiku; moderator Opus), `--rounds 2`, topik ide hackathon.
  - Selesai dalam sekitar 6 menit dengan 12 panggilan. `total_cost_usd` menurut Claude Code $2,24 (estimasi sisi klien).
  - Ronde 2: ketiganya memilih "setuju dengan catatan", tapi Haiku tetap mencantumkan keberatan pemblokir (angka IASC berbeda antar-panelis). Kode menghitungnya sebagai tidak setuju, jadi hasilnya 2/3.
  - Suara akhir: 3/3, **bulat**. Ide terpilih adalah "CekDulu", pemeriksa pesan, tautan, dan rekening sebelum transfer.
  - Temuan 1: WebFetch para panelis ditolak proxy di lingkungan cloud, jadi tidak ada kutipan langsung. Semua angka di laporan diberi label estimasi oleh panelis sendiri. Ini memperkuat kebutuhan verifier di Fase 2.
  - Temuan 2 (bug, sudah diperbaiki): draft moderator dipotong di 8.000 karakter sebelum dinilai panelis, dan ketiganya melaporkan bagian "Risiko" terpotong. Batasnya kini 40.000 karakter, dan moderator diminta menulis draft maksimal sekitar 1.000 kata.
  - Temuan 3 (sudah diperbaiki): judul `##` di draft moderator merusak struktur laporan. Judul di dalam draft kini diturunkan levelnya.
- **Selesai bila:** `council run "ide hackathon ..."` selesai dengan sendirinya dengan status `unanimous`, `majority`, atau `no_consensus`, dan laporannya bisa dibaca. Kriteria ini terpenuhi di cloud.

### Fase 2 — Data & fakta

**Status:** selesai dan dicoba sungguhan dengan Claude di lingkungan cloud. Belum diuji di Windows, dan belum diuji dengan Codex maupun DeepSeek asli.

- **Verifier sumber** (`src/evidence/verify.js`). Program membuka URL setiap klaim, mengubah HTML menjadi teks, lalu mencari kutipannya setelah teks disamakan (huruf kecil, tanpa aksen, "Rp9" = "Rp 9"). Statusnya:
  - ✅ kutipan ditemukan persis
  - ⚠️ kutipan hanya mirip (≥60% trigram), tidak cocok, atau tidak ada
  - ❔ tidak bisa dicek otomatis (HTTP 401/403/429/5xx, PDF, timeout)
  - ❌ sumber tidak ada (404/410, domain tidak ditemukan, URL tidak valid)
  - ➖ klaim fakta tanpa sumber

  Halaman yang sama hanya diunduh sekali per sidang.
- **Daftar klaim bersama** (`src/council/claims.js`). ID-nya K1, K2, … berlaku untuk seluruh sidang, dan klaim yang sama digabung. Agen tanpa web search (DeepSeek) mendapat kutipan dari klaim ✅ sebagai "paket bukti". Moderator hanya boleh menyimpulkan dari klaim ✅.
- **Anonimisasi** (`src/council/anonymize.js`). Panelis dan moderator hanya melihat "Panelis A/B/C" dengan urutan acak. Sudah dites bahwa prompt tidak pernah memuat nama model.
- **Devil's advocate** bergiliran di tiap ronde kritik, menurut urutan alias.
- **Catatan integritas** (dicatat program):
  - setuju tapi menulis keberatan pemblokir (dihitung tidak setuju),
  - suara berubah tanpa `changed_mind.because` atau `change_reason`,
  - berubah pendapat tanpa alasan,
  - merujuk ID klaim yang tidak ada.
- **Pengaturan baru:** token dicatat per panggilan; `--search-budget`; `--no-verify`; `--effort tahap=level` (lihat §16).
- **Uji sungguhan** (2 Okt 2026, topik dan konfigurasi sama dengan uji Fase 1):
  - Hasilnya bulat di suara akhir, 12 panggilan, `total_cost_usd` $1,54.
  - Haiku kembali menulis "setuju" disertai keberatan pemblokir, padahal prompt sudah melarangnya. Program menangkap dan menghitungnya tidak setuju.
  - Opus berubah dari tidak setuju ke setuju dengan catatan, disertai alasan, jadi tidak ditandai.
  - Ke-13 klaim berstatus ❔, karena proxy egress lingkungan cloud menolak situs-situs sumbernya (HTTP 403 pada CONNECT). Situs yang diizinkan, seperti nodejs.org, terbaca normal. Di PC sendiri, hal ini seharusnya tidak terjadi, kecuali situsnya memang memblokir bot.
- **Selesai bila:** laporan memuat tabel klaim dengan status ✅/⚠️/❌, dan kesimpulannya tidak bergantung pada klaim ❌. Kriteria ini terpenuhi di cloud. Namun status ✅ dan ❌ dari situs sungguhan baru terlihat di uji lokal; di cloud yang muncul hanya ❔ karena proxy.

### Fase 3 — UI web dan mode server (Vercel + DeepSeek)

**Status:** kode selesai dan diuji dengan server palsu (94 test). Belum diuji dengan DeepSeek, Upstash, atau Vercel asli, karena butuh API key dan akun milikmu. Detailnya di §18.

- `src/agents/anthropicCompat.js`: agen DeepSeek lewat endpoint Anthropic, dengan web search di sisi server.
- Memori sidang (K8): `council run --lanjut <folder sesi>`, dan pilihan "Lanjutkan dari…" di UI.
- Sidang yang dicicil (K9): jurnal panggilan + pemutaran ulang yang deterministik (`src/cloud/`).
- API (`src/cloud/app.js`) dan UI web tanpa framework (`public/`), dipakai di dua tempat:
  - Vercel (`api/index.js`, `vercel.json`) dengan Upstash Redis: hanya agen API.
  - `council ui` di PC sendiri (127.0.0.1): boleh memakai Claude/Codex lewat login langganan.
- **Selesai bila:** di Vercel, satu sidang DeepSeek dengan web search selesai dari browser HP, laporannya bisa diunduh, dan sidang berikutnya bisa melanjutkan memorinya. **Menunggu dijalankan olehmu.**

### Fase 3b — Pengalaman terminal (nanti)

- Streaming ke `<agen>.log`, opsi `--panes` (Windows Terminal), `council replay <sesi>`, dan skill `/council` untuk Claude Code. Sebagian kebutuhannya (menonton per agen) kini terjawab oleh `council ui`.

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
| Sumber hasil halusinasi. | Verifier di §6; klaim ❌ tidak dipakai. Uji sungguhan menunjukkan model bisa berbeda soal fakta yang sama (Haiku vs Opus/Sonnet soal LTS Node.js). |
| Panelis berbias ke label model (mis. mengalah ke "Opus"). | Fase 1 masih menampilkan nama panelis. Anonimisasi (Panelis A/B/C) dikerjakan di Fase 2. |
| Masalah khas Windows (quoting, `.cmd`, proses yatim). | Pakai ulang `cli.js` dari `chatbot-wa` dan test lewat `.cmd`. |
| Prompt injection dari konten web. | Agen tidak punya tool tulis atau shell; verifikasi dilakukan kode. |
| Lama: satu sidang bisa makan beberapa menit. | Event progres; di WhatsApp, prosesnya asinkron. |

## 15. Pertanyaan terbuka

Sudah dijawab: peran Claude (K1), Gemini (K2), dan bahasa (K3).

Masih terbuka:

1. Web search DeepSeek: sejak Fase 3 memakai pencarian bawaan endpoint Anthropic (F7). Kalau di uji asli ternyata tidak jalan, pilihannya kembali ke "paket bukti", atau API pencarian tambahan (butuh key lain).
2. `chatbot-wa` memanggil `thecouncil` sebagai subprocess, meng-import-nya sebagai library, atau memanggil API Vercel (§11)? Diputuskan sebelum Fase 4. Kalau semua agen DeepSeek, API Vercel paling sederhana.

## 16. Hemat token tanpa memotong isi (K6)

Isi debat tidak dipotong atau diringkas sebelum dibaca panelis lain. Penghematan diambil dari tiga hal: tidak mengulang isi, mengukur pemakaian, dan pengaturan yang tidak mengubah isi.

### Pengukuran

Semua di bawah adalah Claude Code v2.1.287 di lingkungan cloud, 2 Okt 2026.

**Biaya tetap per panggilan** (Haiku, prompt "SIAP"):

| Varian | Token input |
|---|---|
| Tanpa tool | 946 |
| Tanpa tool + `--disable-slash-commands` | 946 |
| Dengan WebSearch + WebFetch | 2.808 |

- Skill dan plugin yang termuat tidak menambah token.
- Definisi tool web menambah sekitar 1.900 token.
- Tidak ada cache hit di panggilan sekecil ini.

**Sidang sungguhan** (topik dan konfigurasi sama, `--rounds 2`, masing-masing satu kali):

| | Fase 1 | Fase 2 |
|---|---|---|
| Panggilan | 12 | 12 |
| `total_cost_usd` (estimasi sisi klien) | $2,24 | $1,54 |
| Hasil | bulat di suara akhir | bulat di suara akhir |

Ini hanya satu sidang per versi, dan isi debatnya berbeda. Di Fase 2, panelis mengusulkan tiga masalah berbeda di ronde 1. Jadi selisih $0,70 **tidak bisa dianggap sepenuhnya hasil optimasi**.

**Rincian Fase 2 per tahap:**

| Tahap | Panggilan | Token input (dari cache) | Token output | Estimasi biaya |
|---|---|---|---|---|
| Jawaban panelis | 6 | 145.010 (76.214) | 26.622 | $0,97 |
| Rangkuman moderator | 2 | 24.081 (0) | 8.708 | $0,37 |
| Suara akhir | 3 | 21.722 (0) | 10.610 | $0,18 |
| Merumuskan pertanyaan | 1 | 1.452 (1.450) | 664 | $0,01 |

Temuan:

1. **Jawaban panelis adalah 63% biaya.** Inputnya didominasi hasil pencarian web di dalam satu panggilan: setiap pencarian membuat konteks dikirim ulang. Di sinilah prompt caching Claude Code benar-benar bekerja (76.214 token dibaca dari cache).
2. **Token output sekitar 2 sampai 17 kali lebih banyak dari teks yang terlihat** (perkiraan kasar: jumlah karakter ÷ 3,5). Selisihnya adalah "thinking". Contoh paling ekstrem: suara akhir Haiku memakai 8.377 token output, sedangkan JSON-nya hanya sekitar 484 token.
3. **Rangkuman dan suara menulis cache (sekitar 46.000 token) yang tidak pernah dibaca lagi.** Urutan "statis di depan" tidak menghasilkan cache hit di Claude Code. Dugaanku (belum diverifikasi), cache hanya cocok di batas blok pesan, sedangkan seluruh prompt adalah satu blok. Urutan ini tetap dipakai karena tidak merugikan, dan mungkin membantu cache otomatis DeepSeek/OpenAI. Itu juga belum diukur.
4. **Effort.** Prompt suara akhir yang sama dijalankan dengan Haiku. Effort bawaan menghasilkan 4.753 token output ($0,0276); effort `low` menghasilkan 2.950 token output ($0,0185), atau −38% token dan −33% biaya. Tapi suaranya berubah dari AGREE_WITH_RESERVATIONS menjadi DISAGREE. Itu baru satu sampel, jadi belum bisa dibedakan efek effort atau variasi acak.

### Yang sudah diterapkan

- Token per panggilan dicatat (input, dari cache, output, estimasi biaya), dirinci per peran dan per tahap di laporan. Codex CLI belum melaporkan token.
- Daftar klaim bersama: klaim ditulis sekali, lalu dirujuk lewat ID.
- Bagian statis prompt di depan.
- `--search-budget` (bawaan 3 pencarian per panelis per ronde). Klaim ✅ tidak perlu dicari ulang.
- `effort` per tahap. Bawaannya hanya `repair: low`, karena perbaikan format JSON tidak menilai apa pun. Tahap lain memakai effort bawaan model.
- Tidak ada pemotongan. Pengaman 60.000 karakter per teks hanya untuk jawaban yang rusak.

### Opsi berikutnya (belum diterapkan)

| Opsi | Dampak yang diharapkan | Risiko |
|---|---|---|
| `--effort vote=low` | Token output suara turun (−38% pada satu sampel) | Bisa mengubah suara |
| `--search-budget 2` | Token input panelis turun (belum diukur) | Riset lebih dangkal |
| Moderator hanya mengirim bagian draft yang berubah | Token output moderator turun | Salah menggabungkan bagian |
| Satu "peneliti" bersama untuk semua pencarian | Pencarian tidak diulang 3× | Panelis kurang independen |
| Skill gaya "caveman" (jawaban sangat ringkas) | Pembuatnya mengklaim −65% output untuk prosa (belum diverifikasi) | Argumen kehilangan nuansa. Lagi pula skill tidak dipanggil di `claude -p` dengan `--tools` terbatas |
| Format TOON untuk data terstruktur | Benchmark pihak ketiga mengklaim sekitar 40% lebih hemat dari JSON untuk data seragam (tokenizer GPT) | Prompt sidang kebanyakan prosa, jadi manfaatnya kecil |

### Soal skill dan plugin

- Setiap panggilan sidang adalah `claude -p` baru dengan system prompt sendiri dan tool yang dibatasi. Daftar skill tidak menambah token (diukur di atas), dan tool Skill tidak tersedia, jadi menginstal skill tidak mengubah panggilan sidang.
- Plugin hemat token di katalog (Token Shield, Token Inspector, token-usage) dirancang untuk sesi Claude Code interaktif yang panjang. Plugin itu berguna untuk sesi kerja kamu sendiri, bukan untuk pipeline sidang ini.

## 17. Sumber

Dibaca langsung:

- Claude Code, *Run Claude Code programmatically*: https://code.claude.com/docs/en/headless
- Claude Code, *Legal and compliance*: https://code.claude.com/docs/en/legal-and-compliance
- Gemini CLI, diskusi resmi tentang penghentian akun individu: https://github.com/google-gemini/gemini-cli/discussions/28017
- Gemini CLI README (kemungkinan belum diperbarui): https://github.com/google-gemini/gemini-cli
- Kode `yearsky/chatbot-wa`: `src/ai/cli.js`, `src/ai/claudeCli.js`, `src/ai/claudeSession.js`, `src/ai/codexCli.js`, `docs/SDD.md`, `test/helpers.js`
- `claude --help` (v2.1.287)

Hanya dari hasil pencarian, halamannya belum aku buka (cek sendiri):

- Skill "caveman" (klaim penghematan dari pembuatnya): https://gittrend.io/repo/JuliusBrussee/caveman
- Format TOON: https://www.analyticsvidhya.com/blog/2025/11/toon-token-oriented-object-notation/ dan https://arxiv.org/pdf/2603.03306
- Penundaan perubahan billing Agent SDK: https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/ dan https://devops.com/anthropic-hits-pause-on-claude-agent-sdk-billing-change-for-now/
- Codex, mode non-interaktif: https://developers.openai.com/codex/noninteractive. Konfigurasi web search: https://developers.openai.com/codex/config-basic
- DeepSeek API (sumber sekunder): https://www.morphllm.com/deepseek-api. Docs resmi: https://api-docs.deepseek.com
- DeepSeek, format Anthropic dan web search: https://api-docs.deepseek.com/guides/anthropic_api/ (diblokir proxy, tidak terbaca). Kutipan docs-nya ada di https://github.com/anomalyco/opencode/issues/32273 (terbaca), dan contoh kode di https://github.com/mengrru/Spherse/pull/105 (terbaca)
- Harga dan nama model DeepSeek (sumber sekunder, saling berbeda): https://benchlm.ai/deepseek/api-pricing dan https://www.nxcode.io/resources/news/deepseek-api-pricing-complete-guide-2026
- Vercel Functions, batas durasi: https://vercel.com/docs/functions/limitations dan https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute
- Vercel Deployment Protection: https://vercel.com/docs/deployments/deployment-protection
- Vercel Storage / Marketplace (Upstash, Neon): https://vercel.com/docs/storage
- Vercel Functions, runtime Node.js (export `GET`/`POST` Web-standard, `waitUntil`): https://vercel.com/docs/functions/runtimes/node-js dan https://vercel.com/docs/functions/functions-api-reference
- Vercel Workflow (tidak dipakai, K9): https://www.createwith.com/tool/vercel/updates/vercel-workflows-reaches-general-availability-for-long-running-processes

Dibaca langsung dari paket npm `@vercel/functions` 3.9.11: `waitUntil` dan `getDeadline` ("Returns the shared invocation deadline for the current function invocation").
- llm-council (Karpathy): https://www.analyticsvidhya.com/blog/2025/12/llm-council-by-andrej-karpathy/

## 18. Mode server (Vercel + DeepSeek) dan UI web (Fase 3)

### Kenapa bentuknya begini

- **Batas durasi fungsi.** Menurut hasil pencarian (docs Vercel diblokir proxy di lingkunganku **[cek]**), dengan Fluid compute fungsi Hobby maksimal 300 dtk dan Pro 800 dtk. Sidang Claude ke-2 di §16 butuh total 511 dtk waktu panggilan, jadi satu sidang bisa lebih lama dari satu fungsi.
- **Tidak ada disk permanen** di Vercel, jadi status disimpan di Upstash Redis (Vercel Marketplace), dipanggil lewat REST dengan `fetch` biasa.
- **Domain publik** di Hobby: lihat §12.

### Sidang yang dicicil (`src/cloud/runner.js`, `src/cloud/journal.js`)

1. `POST /api/runs` menyimpan sidang baru (topik, config tanpa rahasia, seed acak, memori yang dibawa), lalu memulai slice pertama lewat `waitUntil`.
2. Setiap slice memutar ulang `runCouncil()` dari awal:
   - Panggilan AI yang sudah pernah selesai, termasuk yang gagal, diambil dari jurnal di Redis, tanpa memanggil API lagi.
   - Panggilan baru hanya dimulai kalau masih ada waktu untuk satu panggilan penuh: batas fungsi (dari `getDeadline()` Vercel, atau 300 dtk) dikurangi timeout panggilan (180 dtk) dan margin (20 dtk). Kalau tidak, slice berhenti dengan sinyal "jeda", setelah menunggu panggilan yang sedang berjalan selesai dan tercatat.
   - Hasil verifikasi sumber juga dijurnal.
3. Supaya pemutaran ulang menghasilkan sidang yang persis sama:
   - Alias Panelis A/B/C diacak dari seed sidang (`mulberry32`).
   - Setiap hasil (dari jurnal maupun panggilan baru) diserahkan ke sidang menurut nomor urut selesainya di slice aslinya. Urutan ini menentukan ID klaim (K1, K2, …), yang ikut masuk prompt tahap berikutnya. Tanpa ini, kunci jurnal tahap berikutnya bisa berbeda dan panggilan AI terulang.
   - Event diberi ID tetap per kejadian, jadi event yang sama tidak disimpan dua kali.
   - Diuji dengan sidang yang dipaksa terpotong di tengah ronde paralel dalam banyak slice, dengan urutan selesai acak di tiap slice, lalu diputar ulang dari jurnal saja: tidak ada panggilan AI yang terulang dan event-nya identik.
4. Slice berikutnya dimulai oleh siapa pun yang membuka sidang (`GET /api/runs/<id>/events/<n>`), kalau sidang belum selesai dan tidak ada slice yang berjalan (kunci `SET NX` di Redis). Jadi sidang **berhenti sementara kalau tidak ada yang membuka** (K9), dan lanjut sendiri begitu dibuka lagi.
5. Kalau jurnal gagal disimpan, sidang dihentikan dengan pesan jelas, karena tanpa jurnal slice berikutnya bisa mendapat jawaban berbeda.

Kunci Redis: `run:<id>:meta|events|journal|lock|cancel|report`, `memory:<id>`, `runs`, `active`, `active-clear:<nilai slot>`, `quota:<tanggal>`, `login-fail:<ip>`, `models`.

Batas waktu dan slot:

- Satu panggilan agen DeepSeek, termasuk lanjutan `pause_turn` dan percobaan tanpa web search, berbagi satu batas waktu (`timeoutMs`). Dengan begitu satu panggilan tidak pernah melewati waktu yang disisakan runner.
- Slot "satu sidang berjalan" (`active`, nilainya `<id>|<waktu klaim>`) diklaim dengan `SET NX`, jadi dua permintaan bersamaan tidak bisa sama-sama lolos. Pemegang yang sidangnya belum tercatat dianggap sedang dibuat selama 2 menit. Pemegang yang sidangnya sudah berhenti boleh digantikan, tapi hanya oleh satu permintaan.
- Sidang yang selesai dengan status `error` (mis. semua panelis gagal) dicatat sebagai error, bukan selesai, dan tidak menyimpan memori untuk dilanjutkan.

### Memori sidang (K8)

- Saat sidang selesai, disimpan: topik, pertanyaan, status, ringkasan, draft akhir, dan klaim ✅ (teks, URL, kutipan, hasil verifikasi). Isinya diambil persis dari hasil sidang, bukan ringkasan buatan AI.
- Sidang baru yang memilih "Lanjutkan dari…" (UI) atau `--lanjut` (CLI):
  - Klaim ✅ lama langsung masuk daftar klaim dengan ID-K dan tidak dicek ulang.
  - Blok "Memori sidang sebelumnya" masuk ke bagian statis semua prompt (frame, panel, judge, vote), dengan aturan bahwa memori adalah konteks, bukan bukti baru.
  - Laporan mencatat sidang mana yang dilanjutkan.
- Konsekuensi yang perlu diketahui: ronde blind tidak lagi sepenuhnya "bersih", karena semua panelis melihat kesimpulan lama. Ini memang yang diminta saat memilih "lanjutkan".
- Status ✅ yang dibawa adalah hasil cek di sidang lama. Halaman sumbernya bisa sudah berubah.

### Agen DeepSeek (`src/agents/anthropicCompat.js`)

- `POST <baseURL>/v1/messages` dengan header `x-api-key` dan `Authorization: Bearer` (keduanya, karena docs Claude Code DeepSeek memakai `ANTHROPIC_AUTH_TOKEN` **[cek]**), plus `anthropic-version: 2023-06-01`.
- Web search: `tools: [{"type": "web_search_20250305", "name": "web_search", "max_uses": <searchBudget>}]`. URL hasil pencarian dicatat di `meta.searchUrls`.
- `stop_reason: "pause_turn"` dilanjutkan otomatis (maks. 3 kali).
- `stop_reason: "max_tokens"` dicatat dan muncul di laporan sebagai peringatan, karena jawabannya mungkin terpotong. `maxTokens` bawaan 32.000.
- Kalau endpoint menolak tool web search (HTTP 4xx selain 401/402/429), agen mencoba sekali tanpa tool dan mencatat alasannya; doctor menampilkannya sebagai peringatan.
- Biaya hanya dihitung kalau `pricing` (USD per 1 juta token: `input`, `cacheRead`, `output`) diisi di config agen. Harga DeepSeek tidak di-hardcode karena berubah dan ada harga jam sibuk/sepi.

### Perkiraan biaya (kasar)

Token sidang Claude ke-2 (§16: 192.265 token input, 77.664 di antaranya dari cache, 46.604 output), dikalikan harga DeepSeek dari sumber sekunder (jam sibuk; Flash $0,30 input, $0,006 dari cache, $1,20 output per 1 juta token), hasilnya sekitar **$0,09** per sidang. Dengan Pro, batas atasnya sekitar **$0,44** (semua input dihitung tanpa cache). Ini perkiraan, bukan fakta: jumlah token DeepSeek akan berbeda, harga dari sumber sekunder bisa salah atau berubah, dan biaya web search DeepSeek belum aku ketahui. Laporan setiap sidang mencatat token yang sebenarnya.

### Risiko kualitas: panel satu keluarga model

Kalau semua panelis DeepSeek, kesalahannya cenderung sama, jadi debat kurang independen dibanding panel Claude/Codex/DeepSeek. Mitigasi yang ada: campur model (mis. Pro dan Flash), alias anonim, devil's advocate, dan verifier sumber oleh program. Seberapa besar efeknya belum diukur.

### Yang belum diverifikasi

- Semua perilaku API DeepSeek asli (nama model, web search, format usage, header).
- Nama env dari integrasi Upstash di Vercel (`KV_REST_API_URL`/`KV_REST_API_TOKEN` atau `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`; keduanya dibaca).
- Rewrite `vercel.json` (`/api/:path+` → `/api?path=:path+`) dan export `GET`/`POST` di fungsi tanpa framework. `routeOf()` menerima path langsung maupun `?path=`, untuk berjaga-jaga.
- Apakah `waitUntil` benar-benar menjaga slice tetap jalan sampai selesai setelah respons dikirim.
- Apakah situs sumber berbahasa Indonesia bisa dibuka dari IP Vercel (verifier).
