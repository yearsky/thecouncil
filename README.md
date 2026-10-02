# The Council 🏛️

Sidang debat beberapa agen AI dari terminal Windows: **Claude** (Claude Code CLI), **Codex** (Codex CLI), dan **DeepSeek** (API). Claude memimpin sidang dan juga ikut berdebat. Rencana lengkap ada di [docs/PLAN.md](docs/PLAN.md).

**Status: Fase 2.** Yang sudah tersedia:

- `council run`: sidang debat sungguhan, dengan pengecekan sumber oleh program.
- `council doctor`: memeriksa apakah tiap agen siap dipakai.

## Kebutuhan

- [Node.js](https://nodejs.org) versi 22 atau lebih baru
- Claude Code: `npm install -g @anthropic-ai/claude-code`, lalu jalankan `claude` sekali untuk login dengan akun langganan Claude
- Codex CLI: `npm install -g @openai/codex`, lalu `codex login` dengan akun ChatGPT
- API key DeepSeek (bayar per pemakaian)

## Instalasi (PowerShell)

```powershell
git clone https://github.com/yearsky/thecouncil.git
cd thecouncil
git checkout claude/amazing-hawking-5y1jf8
Copy-Item council.config.example.json council.config.json
Copy-Item .env.example .env
notepad .env
```

Di `.env`, isi `DEEPSEEK_API_KEY`. Belum perlu `npm install`, karena proyek ini belum memakai dependensi npm.

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

**Kuota.** Laporan mencatat token input, token dari cache, token output, dan estimasi biaya untuk tiap peran dan tahap. Codex CLI belum melaporkan token. Penghematan token dilakukan tanpa memotong isi debat; lihat [docs/PLAN.md](docs/PLAN.md) §17.

Dengan P panelis dan R ronde, paling banyak terjadi 1 + R × (P + 1) + P panggilan. Jumlahnya bertambah kalau ada jawaban yang perlu diperbaiki formatnya. Contohnya, 3 panelis dengan 2 ronde berarti paling banyak 12 panggilan.

### Hanya punya langganan Claude?

Panel bisa diisi Claude dengan model yang berbeda-beda:

```powershell
node src/index.js run "..." -c examples/claude-only.json
```

Dengan [examples/claude-only.json](examples/claude-only.json), panelisnya Claude Opus, Sonnet, dan Haiku, dan moderatornya Opus. Setiap panelis adalah panggilan `claude -p` terpisah, tapi semuanya memakai kuota langganan yang sama.

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
| `agents.<id>.extraArgs` | Argumen tambahan untuk CLI, mis. `["--restricted"]` untuk Claude |
| `agents.<id>.timeoutMs` | Batas waktu per panggilan, dalam milidetik |

Jangan menambahkan `--bare` untuk Claude: dengan flag itu, login langganan tidak terbaca.

## Test

```powershell
npm test
```

Test memakai agen palsu, jadi tidak memakai kuota.

## Catatan pemakaian

The Council dirancang untuk **pemakaian pribadi** di PC sendiri, dengan akun langgananmu sendiri. Ketentuan langganan Claude ada di [docs/PLAN.md](docs/PLAN.md) §2 (F3); baca sumber aslinya juga.
