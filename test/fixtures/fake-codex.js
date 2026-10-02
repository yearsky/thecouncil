#!/usr/bin/env node
// Meniru `codex exec ... --output-last-message <file> -`: prompt dari stdin, jawaban ke file.
// Mode lewat env FAKE_CODEX_MODE: ok (bawaan) | fail.
import fs from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('codex-cli 9.9.9\n')
  process.exit(0)
}

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_MODE === 'fail') {
    process.stderr.write('Error: Not logged in. Run codex login\n')
    process.exit(1)
  }
  const out = args[args.indexOf('--output-last-message') + 1]
  const web = args.includes('web_search=live')
  const answer = input.includes('SIAP')
    ? 'SIAP'
    : web
      ? `Versi LTS terbaru Node.js adalah 24 (${process.env.FAKE_URL || 'https://example.invalid/x'})`
      : 'tanpa web'
  fs.writeFileSync(out, answer)
  process.stdout.write('log codex\n')
})
