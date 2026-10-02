// Menjalankan CLI (claude / codex) sebagai subprocess, lintas platform.
// Prompt selalu dikirim lewat stdin agar tidak ada masalah quoting di cmd/PowerShell.
// Disalin dari yearsky/chatbot-wa (src/ai/cli.js); bedanya: error membawa stdout/stderr.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'

const IS_WINDOWS = process.platform === 'win32'

// Di Windows, CLI hasil `npm i -g` berupa .cmd sehingga butuh shell,
// dan Node menggabungkan argumen apa adanya → quote manual.
function quoteWinArg(arg) {
  if (arg === '') return '""'
  if (!/[\s"&|<>^%()]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export function spawnCli(bin, args, { cwd } = {}) {
  // spawn melempar ENOENT (mirip "perintah tidak ditemukan") jika cwd belum ada.
  if (cwd) fs.mkdirSync(cwd, { recursive: true })
  return spawn(IS_WINDOWS ? quoteWinArg(bin) : bin, IS_WINDOWS ? args.map(quoteWinArg) : args, {
    cwd,
    shell: IS_WINDOWS,
    windowsHide: true,
    env: process.env
  })
}

// Di Windows child.kill() hanya mematikan cmd.exe, bukan proses claude/codex di bawahnya.
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (IS_WINDOWS && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill()
  }
}

export function spawnErrorMessage(bin, err) {
  return err.code === 'ENOENT' ? `Perintah "${bin}" tidak ditemukan. Sudah diinstal?` : err.message
}

export function runCli(bin, args, { input = '', timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnCli(bin, args, { cwd })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }

    const timer = setTimeout(() => {
      killTree(child)
      finish(reject, new Error(`${bin} tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik`))
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => finish(reject, new Error(spawnErrorMessage(bin, err))))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr })
      else {
        const detail = (stderr || stdout).trim().split('\n').slice(-5).join('\n')
        const err = new Error(`${bin} keluar dengan kode ${code}${detail ? `: ${detail}` : ''}`)
        Object.assign(err, { exitCode: code, stdout, stderr })
        finish(reject, err)
      }
    })

    child.stdin.on('error', () => {}) // proses bisa keluar sebelum stdin selesai ditulis
    child.stdin.end(input)
  })
}

// Cek apakah CLI terpasang; mengembalikan string versi atau null.
export async function cliVersion(bin) {
  try {
    const { stdout } = await runCli(bin, ['--version'], { timeoutMs: 30000 })
    return stdout.trim().split('\n')[0] || 'terpasang'
  } catch {
    return null
  }
}
