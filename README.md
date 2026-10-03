# The Council 🏛️

Sidang debat beberapa agen AI: **Claude** (Claude Code CLI), **Codex** (Codex CLI), dan **DeepSeek** (API). Claude memimpin sidang dan juga ikut berdebat. Rencana lengkap ada di [docs/PLAN.md](docs/PLAN.md).

**Status: Fase 3.** Yang sudah tersedia:

- `council run`: sidang debat sungguhan dari terminal, dengan pengecekan sumber oleh program.
- `council doctor`: memeriksa apakah tiap agen siap dipakai.
- `council ui`: UI web di PC sendiri, bisa memakai Claude/Codex lewat login langganan.
- **Mode server di Vercel**, semua agen DeepSeek (API key), bisa dibuka dari HP. Lihat [Deploy ke Vercel](#deploy-ke-vercel-semua-deepseek).
- **Melanjutkan sidang**: kesimpulan dan klaim ✅ sidang lama dibawa ke sidang baru, apa adanya.

Mode server baru diuji dengan server palsu, belum dengan DeepSeek, Upstash, atau Vercel asli.

## Kebutuhan

- [Node.js](https://nodejs.org) versi 22 atau lebih baru
- Claude Code: `npm install -g @anthropic-ai/claude-code`, lalu jalankan `claude` sekali untuk login dengan akun langganan Claude
- Codex CLI: `npm install -g @openai/codex`, lalu `codex login` dengan akun ChatGPT
- API key DeepSeek (bayar per pemakaian)

## Instalasi (PowerShell)

```powershell
git clone https://github.com/yearsky/thecouncil.git
cd thecouncil
Copy-Item council.config.example.json council.config.json
Copy-Item .env.example .env
notepad .env
```

Di `.env`, isi `DEEPSEEK_API_KEY`. Untuk CLI tidak perlu `npm install`: CLI tidak memakai dependensi npm. Satu-satunya dependensi (`@vercel/functions`) hanya dipakai di Vercel.

Kalau mau perintah `council` bisa dipanggil dari folder mana saja, jalankan `npm link` (opsional).

## Menjalankan sidang

```powershell
node src/index.js run "Ide hackathon tentang keuangan UMKM yang bisa dibuat dalam 48 jam"
node src/index.js run "..." --rounds 2 --moderator-model opus
node src/index.js run "..." --json > events.jsonl     # event per baris, untuk bot WhatsApp
```

Jalannya sidang:

1. Moderator merumuskan pertanyaan dan kriteria keberhasilan.
2. **Ronde 1 (blind):** semua panelis menjawab paralel tanpa melihat jawaban yang lain.
3. Moderator merangkum hasilnya dan menyusun draft kesimpulan.
4. **Ronde kritik:** panelis membaca draft dan jawaban panelis lain, mengkritik, memperbarui posisinya, lalu memberi suara atas draft.
5. Sidang berhenti kalau semua setuju. Kalau batas ronde habis dan belum sepakat, ada pemungutan suara akhir, dan hasilnya dilaporkan apa adanya: bulat, mayoritas, atau tidak ada konsensus.

Fitur yang menjaga debat tetap jujur (Fase 2):

- **Pengecekan sumber oleh program.** Setiap klaim yang punya URL dicek: halamannya dibuka, lalu kutipannya dicari di halaman itu. Hasilnya:
  - ✅ kutipan ditemukan
  - ⚠️ kutipan tidak cocok
  - ❔ tidak bisa dicek (situs memblokir bot, PDF, atau timeout); bukan berarti salah
  - ❌ sumber tidak ada
  - ➖ klaim fakta tanpa sumber

  Moderator hanya boleh menyimpulkan dari klaim ✅.
- **Daftar klaim bersama (K1, K2, …).** Setiap klaim ditulis sekali, dan panelis cukup merujuk ID-nya.
- **Anonim.** Panelis dan moderator hanya melihat "Panelis A/B/C", bukan nama modelnya. Pemetaan aslinya ada di laporan.
- **Devil's advocate.** Di setiap ronde kritik, satu panelis bergiliran wajib mencari kelemahan draft.
- **Catatan integritas.** Program mencatat suara yang berubah tanpa alasan, dan suara "setuju" yang tetap menulis keberatan pemblokir. Suara seperti itu dihitung tidak setuju.

Hasil sidang disimpan di `sessions/<waktu>_<topik>/`:

- `report.md`: kesimpulan, suara, klaim dan sumber, jalannya sidang, pemakaian
- `events.jsonl`: seluruh kejadian
- `memory.json`: memori untuk melanjutkan sidang ini (kesimpulan + klaim ✅)

### Melanjutkan sidang

Tiap sidang mulai bersih: tidak ada sesi AI permanen dan tidak ada ringkasan otomatis yang bisa menghilangkan detail. Kalau ingin melanjutkan topik lama, bawa memorinya secara eksplisit:

```powershell
node src/index.js run "Lanjutkan: susun rencana MVP untuk ide terpilih" --lanjut 2026-10-02_155759_brainstorming-ide-hackathon-masalah-nyat
```

Kesimpulan dan klaim ✅ sidang itu ikut masuk ke semua prompt sebagai konteks (bukan bukti baru), dan klaim ✅-nya tidak dicek ulang. `--lanjut` boleh diulang untuk beberapa sidang. Di UI, pilihannya ada di "Lanjutkan dari sidang sebelumnya".

| Opsi | Arti |
|---|---|
| `--rounds <n>` | Maksimal ronde debat sebelum suara akhir (bawaan 3) |
| `--consensus bulat\|mayoritas` | Sidang boleh berhenti lebih awal kalau sudah bulat, atau cukup mayoritas |
| `--panel a,b,c` | Pilih panelis dari agen di config |
| `--moderator <id>`, `--moderator-model <model>` | Pilih agen dan model moderator |
| `--model <id>=<model>` | Ganti model satu agen, mis. `--model claude=haiku` (boleh diulang) |
| `--no-web` | Matikan web search |
| `--search-budget <n>` | Maksimal pencarian web per panelis per ronde (bawaan 3; `0` = tanpa batas) |
| `--no-verify` | Jangan periksa sumber klaim |
| `--effort <tahap>=<level>` | Effort (porsi "thinking") Claude per tahap: `frame`, `panel`, `judge`, `vote`, `repair`; level `low`…`max`. Menurunkannya menghemat token, tapi bisa mengubah hasil penilaian. Lihat [docs/PLAN.md](docs/PLAN.md) §16 |
| `--lanjut <folder sesi>` | Lanjutkan dari sidang lama (lihat di atas) |

**Kuota.** Laporan mencatat token input, token dari cache, token output, dan estimasi biaya untuk tiap peran dan tahap. Codex CLI belum melaporkan token. Penghematan token dilakukan tanpa memotong isi debat; lihat [docs/PLAN.md](docs/PLAN.md) §16.

Dengan P panelis dan R ronde, paling banyak terjadi 1 + R × (P + 1) + P panggilan. Jumlahnya bertambah kalau ada jawaban yang perlu diperbaiki formatnya. Contohnya, 3 panelis dengan 2 ronde berarti paling banyak 12 panggilan.

### Hanya punya langganan Claude?

Panel bisa diisi Claude dengan model yang berbeda-beda:

```powershell
node src/index.js run "..." -c examples/claude-only.json
```

Dengan [examples/claude-only.json](examples/claude-only.json), panelisnya Claude Opus, Sonnet, dan Haiku, dan moderatornya Opus. Setiap panelis adalah panggilan `claude -p` terpisah, tapi semuanya memakai kuota langganan yang sama.

### Hanya DeepSeek?

[examples/deepseek-only.json](examples/deepseek-only.json) berisi tiga panelis DeepSeek (Pro, Flash, Flash B) dengan moderator Pro. Isi dulu `model` tiap agen dengan nama dari `council doctor`. Catatan: panel satu keluarga model cenderung keliru di hal yang sama, jadi campur model yang berbeda kalau bisa.

## UI web di PC sendiri

```powershell
node src/index.js ui              # buka http://127.0.0.1:8787
node src/index.js ui --port 9000
```

- Memakai config yang sama dengan `council run`, termasuk Claude/Codex lewat login langgananmu. Server hanya mendengarkan di 127.0.0.1.
- Sidang di UI lokal disimpan di memori proses, jadi hilang saat UI ditutup. Unduh laporannya (.md) kalau perlu.
- Kalau `COUNCIL_PASSWORD` diisi di `.env`, UI lokal juga meminta password.

## Deploy ke Vercel (semua DeepSeek)

Di Vercel hanya agen API (bayar per token) yang dipakai. Claude/Codex lewat login langganan **tidak** boleh dan tidak bisa dijalankan di server (lihat [docs/PLAN.md](docs/PLAN.md) F3 dan K7).

1. Siapkan API key dan saldo DeepSeek di platform DeepSeek.
2. Di Vercel: **Add New → Project**, impor repo `yearsky/thecouncil` (branch `main`). Framework preset: **Other**, tanpa build command. `vercel.json` sudah mengatur folder `public/` dan fungsi `api/index.js`.
3. Di tab **Storage** project itu, pasang **Upstash Redis** dari Marketplace dan hubungkan ke project. Env Redis-nya diisi otomatis oleh integrasi. Nama env-nya belum aku cek; kode membaca `KV_REST_API_URL`/`KV_REST_API_TOKEN` maupun `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.
4. Isi **Environment Variables**:

   | Nama | Isi |
   |---|---|
   | `DEEPSEEK_API_KEY` | API key DeepSeek |
   | `COUNCIL_PASSWORD` | Password login UI. Wajib; tanpa ini server menolak semua sidang |
   | `COUNCIL_SECRET` | Opsional: teks acak panjang untuk menandatangani cookie |
   | `COUNCIL_API_TOKEN` | Opsional: token untuk bot WhatsApp (`Authorization: Bearer ...`) |
   | `COUNCIL_DAILY_RUNS` | Opsional: batas sidang per hari (bawaan 10) |
   | `COUNCIL_CONFIG` | Opsional: config JSON pengganti [examples/deepseek-only.json](examples/deepseek-only.json) |

5. Deploy, buka URL-nya, login, lalu buka **Cek agen**: cek cepat dulu, lalu cek lengkap (memakai sedikit token). Cek lengkap menunjukkan apakah web search DeepSeek jalan.
   - Project Vercel baru memakai **Vercel Authentication**, jadi login Vercel dulu di browser (juga di HP).
   - Cek cepat apakah fungsinya jalan: buka `/api?path=health`, harus menampilkan `{"ok":true,"kv":"upstash","auth":true,...}`.
6. Di **Sidang baru**, pilih model tiap panelis dari daftar, lalu mulai.

Cara kerjanya di Vercel:

- Fungsi Vercel paket Hobby dibatasi sekitar 5 menit per pemanggilan, jadi sidang dikerjakan **bertahap**. Setiap jawaban AI disimpan di Redis, dan tahap berikutnya melanjutkan dari situ tanpa memanggil ulang.
- Sidang maju selama halamannya terbuka (atau bot WA memantaunya). Kalau semua tab ditutup, sidang **dijeda** dan lanjut sendiri saat dibuka lagi.
- Paket Hobby Vercel untuk pemakaian pribadi non-komersial (setahuku; cek ketentuannya). Domain produksinya bisa dibuka siapa saja, makanya ada password, batas harian, dan hanya satu sidang berjalan pada satu waktu.

Detail teknis dan hal yang belum terverifikasi ada di [docs/PLAN.md](docs/PLAN.md) §18.

## Memeriksa agen

```powershell
node src/index.js doctor --quick          # cek terpasang dan API key saja, tanpa memakai kuota AI
node src/index.js doctor                  # uji lengkap: jawaban dasar + web search
node src/index.js doctor --agent codex    # satu agen saja
node src/index.js doctor --json > doctor.json
```

Doctor lengkap memakai sedikit kuota:

- Claude: 2 panggilan, atau 3 kalau model moderatornya berbeda
- Codex: 2 panggilan
- DeepSeek: 1 panggilan berbayar

Arti tanda: ✔ siap · ⚠ peringatan · ✖ gagal · – dilewati · • info

Hal yang paling penting dilihat dari hasilnya:

- **Codex → web search**: apakah cara menyalakan web search-nya benar. Kalau gagal, coba ganti `webSearchArgs` (lihat tabel di bawah).
- **DeepSeek → model**: daftar model yang tersedia. Pilih salah satu dan isi di `agents.deepseek.model`.
- **Claude → uji moderator**: apakah model moderator yang kamu pilih tersedia di paket langgananmu.

## Config (`council.config.json`)

| Kunci | Arti |
|---|---|
| `moderator.model` | Model Claude saat jadi moderator, mis. `sonnet`, `opus`, `haiku`, atau nama model lengkap |
| `agents.claude.model` | Model Claude saat ikut debat |
| `agents.codex.model` | Model Codex; kosong = model bawaan Codex |
| `agents.codex.webSearchArgs` | Cara menyalakan web search Codex. Bawaannya `["-c", "web_search=live"]`; kalau gagal, coba `["--search"]` |
| `agents.deepseek.model` | Boleh dikosongkan dulu; doctor akan menampilkan daftar model yang tersedia |
| `agents.deepseek.type` | Bawaan `anthropic-compatible` (endpoint `https://api.deepseek.com/anthropic`, dengan web search). Kalau bermasalah, ganti ke `openai-compatible` dengan `baseURL` `https://api.deepseek.com` (tanpa web search) |
| `agents.<id>.maxTokens` | Batas token jawaban agen API (bawaan 32000). Jawaban yang kena batas ditandai di laporan |
| `agents.<id>.pricing` | Opsional, untuk estimasi biaya agen API: `{"input": 0.3, "cacheRead": 0.006, "output": 1.2}` (USD per 1 juta token; isi dari halaman harga resmi) |
| `agents.<id>.extraArgs` | Argumen tambahan untuk CLI, mis. `["--restricted"]` untuk Claude |
| `agents.<id>.timeoutMs` | Batas waktu per panggilan, dalam milidetik |

Jangan menambahkan `--bare` untuk Claude: dengan flag itu, login langganan tidak terbaca.

## Test

```powershell
npm test
```

Test memakai agen palsu, jadi tidak memakai kuota.

## Catatan pemakaian

The Council dirancang untuk **pemakaian pribadi**. Claude dan Codex dipakai di PC sendiri dengan akun langgananmu sendiri; versi Vercel hanya memakai API key DeepSeek. Ketentuan langganan Claude ada di [docs/PLAN.md](docs/PLAN.md) §2 (F3); baca sumber aslinya juga.
