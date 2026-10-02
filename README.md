# The Council 🏛️

Sidang debat beberapa agen AI dari terminal Windows: **Claude** (Claude Code CLI), **Codex** (Codex CLI), dan **DeepSeek** (API). Claude memimpin sidang dan juga ikut berdebat. Rencana lengkap ada di [docs/PLAN.md](docs/PLAN.md).

**Status: Fase 0.** Yang sudah ada baru `council doctor`, untuk memeriksa apakah tiap agen siap dipakai. Perintah `council run` dikerjakan di Fase 1.

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
