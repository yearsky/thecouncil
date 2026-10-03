#!/usr/bin/env node
// Meniru `claude -p --output-format stream-json --verbose ...`: prompt dari stdin,
// event "init" lalu (opsional) pemanggilan tool lalu event "result".
// Prompt sidang dikenali dari baris "Tahap: ..." dan dijawab dengan JSON yang masuk akal.
// Mode lewat env FAKE_CLAUDE_MODE: ok (bawaan) | not-logged-in | no-search | plugins | disagree.
// FAKE_CLAUDE_DELAY_MS menunda jawaban (uji UI).
import { fenced, stageAnswer, stageOf } from './stage-answers.js'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n')
  process.exit(0)
}

const mode = process.env.FAKE_CLAUDE_MODE || 'ok'
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n')
const source = process.env.FAKE_URL || 'https://example.invalid/x'

let input = ''
process.stdin.on('data', (d) => (input += d))
// FAKE_CLAUDE_DELAY_MS: jeda sebelum menjawab, untuk melihat keadaan "sedang menjawab" di uji UI.
process.stdin.on('end', () => setTimeout(respond, Number(process.env.FAKE_CLAUDE_DELAY_MS || 0)))

function respond() {
  const tools = flag('--tools') ? flag('--tools').split(',') : []
  out({
    type: 'system',
    subtype: 'init',
    model: flag('--model') || 'fake-default',
    tools,
    plugins: mode === 'plugins' ? [{ name: 'superpowers', path: '/x' }] : [],
    mcp_servers: []
  })
  if (mode === 'not-logged-in') {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'Not logged in · Please run /login' })
    process.exit(1)
  }
  if (tools.includes('WebSearch') && mode !== 'no-search') {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } })
  }
  const stage = stageOf(input)
  let answer
  if (stage) answer = fenced(stageAnswer(stage, input, { model: flag('--model') || 'fake', disagree: mode === 'disagree', source }))
  else if (tools.includes('WebSearch')) answer = `Node.js 24 adalah LTS terbaru. Sumber: ${source}.`
  else answer = input.includes('SIAP') ? 'SIAP' : 'tidak tahu'
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.001, args })
}
