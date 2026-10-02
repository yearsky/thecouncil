#!/usr/bin/env node
// Meniru `claude -p --output-format stream-json --verbose ...`: prompt dari stdin,
// event "init" lalu (opsional) pemanggilan tool lalu event "result".
// Prompt sidang dikenali dari baris "Tahap: ..." dan dijawab dengan JSON yang masuk akal.
// Mode lewat env FAKE_CLAUDE_MODE: ok (bawaan) | not-logged-in | no-search | plugins | disagree.
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n')
  process.exit(0)
}

const mode = process.env.FAKE_CLAUDE_MODE || 'ok'
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n')
const source = process.env.FAKE_URL || 'https://example.invalid/x'

function stageAnswer(stage, input) {
  const model = flag('--model') || 'fake'
  const round = Number(input.match(/Ronde (\d+)/)?.[1] || 0)
  const vote = { on_draft: mode === 'disagree' ? 'DISAGREE' : 'AGREE', reservations: [], blocking_objections: mode === 'disagree' ? ['belum ada data'] : [] }
  switch (stage) {
    case 'FRAME':
      return { question: 'Ide hackathon apa yang paling layak?', criteria: ['bisa dibuat 48 jam', 'ada data masalahnya'], context: '' }
    case 'PANEL':
      return {
        position: `Posisi ${model} di ronde ${round}`,
        proposals: [{ id: 'P1', title: 'Aplikasi pencatat keuangan UMKM', why: 'banyak UMKM belum mencatat' }],
        claims: [{ id: 'C1', text: 'Node.js 24 adalah LTS', kind: 'fact', source_url: source, quote: 'Node.js 24 adalah versi LTS' }],
        ...(round > 1 ? { critiques: [], changed_mind: { changed: false }, vote } : {})
      }
    case 'JUDGE':
      return { summary: `Ringkasan ronde ${round}`, agreements: ['fokus UMKM'], disagreements: [], draft: `Draft kesimpulan ronde ${round}`, next_focus: 'data pendukung' }
    case 'VOTE':
      return { vote }
    default:
      return null
  }
}

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
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
  const stage = input.match(/^Tahap: (\w+)/m)?.[1]
  let answer
  if (stage) answer = 'Berikut jawabanku:\n```json\n' + JSON.stringify(stageAnswer(stage, input)) + '\n```'
  else if (tools.includes('WebSearch')) answer = `Node.js 24 adalah LTS terbaru. Sumber: ${source}.`
  else answer = input.includes('SIAP') ? 'SIAP' : 'tidak tahu'
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.001, args })
})
