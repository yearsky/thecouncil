import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, applyRunOptions, loadConfig, mergeConfig, validateConfig } from '../src/config.js'
import { agentIdsInUse } from '../src/agents/index.js'

test('config bawaan: Claude moderator + panelis, panel Claude/Codex/DeepSeek', () => {
  assert.deepEqual(DEFAULT_CONFIG.panel, ['claude', 'codex', 'deepseek'])
  assert.equal(DEFAULT_CONFIG.moderator.agent, 'claude')
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), [])
  assert.deepEqual(agentIdsInUse(DEFAULT_CONFIG), ['claude', 'codex', 'deepseek'])
})

test('mergeConfig menimpa per field tanpa menghapus bawaan', () => {
  const c = mergeConfig(DEFAULT_CONFIG, { moderator: { model: 'opus' }, agents: { deepseek: { model: 'x' } } })
  assert.deepEqual(c.moderator, { agent: 'claude', model: 'opus' })
  assert.equal(c.agents.deepseek.model, 'x')
  assert.equal(c.agents.deepseek.baseURL, 'https://api.deepseek.com/anthropic')
  assert.equal(c.agents.claude.model, 'sonnet')
})

test('validateConfig menolak agen yang tidak ada', () => {
  const errors = validateConfig(mergeConfig(DEFAULT_CONFIG, { panel: ['claude', 'gemini'], moderator: { agent: 'x' } }))
  assert.deepEqual(errors, ['agen panel "gemini" tidak ada di "agents"', 'moderator "x" tidak ada di "agents"'])
})

test('loadConfig: tanpa file pakai bawaan; file dengan BOM (Notepad) tetap terbaca', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-config-'))
  assert.equal(loadConfig({ cwd: dir }).source, null)
  fs.writeFileSync(path.join(dir, 'council.config.json'), '\uFEFF{"moderator":{"model":"opus"}}')
  const c = loadConfig({ cwd: dir })
  assert.equal(c.moderator.model, 'opus')
  assert.equal(c.source, path.join(dir, 'council.config.json'))
  assert.throws(() => loadConfig({ cwd: dir, file: 'tidak-ada.json' }), /tidak ditemukan/)
  fs.writeFileSync(path.join(dir, 'rusak.json'), '{')
  assert.throws(() => loadConfig({ cwd: dir, file: 'rusak.json' }), /Gagal membaca/)
})

test('applyRunOptions: opsi baris perintah tanpa mengubah config asal', () => {
  const base = mergeConfig(DEFAULT_CONFIG, {})
  const { config, errors } = applyRunOptions(base, {
    panel: 'claude, codex',
    'moderator-model': 'opus',
    model: ['codex=gpt-x'],
    rounds: '2',
    consensus: 'mayoritas',
    'no-web': true,
    'no-verify': true,
    'search-budget': '0'
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.panel, ['claude', 'codex'])
  assert.deepEqual(config.moderator, { agent: 'claude', model: 'opus' })
  assert.equal(config.agents.codex.model, 'gpt-x')
  assert.equal(config.maxRounds, 2)
  assert.equal(config.consensus, 'majority')
  assert.equal(config.web, false)
  assert.equal(config.verify, false)
  assert.equal(config.searchBudget, 0)
  assert.equal(base.agents.codex.model, '')
  assert.equal(DEFAULT_CONFIG.moderator.model, 'sonnet')

  const bad = applyRunOptions(base, { model: ['tanpa-sama-dengan', 'x=y'], rounds: '11', consensus: 'semua', 'search-budget': '2.5' })
  assert.equal(bad.errors.length, 5)
})

test('contoh config khusus Claude valid', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../examples/claude-only.json', import.meta.url), 'utf8'))
  const config = mergeConfig(DEFAULT_CONFIG, example)
  assert.deepEqual(validateConfig(config), [])
  assert.ok(config.panel.every((id) => config.agents[id].type === 'claude-cli'))
})

test('council.config.example.json sama dengan config bawaan', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../council.config.example.json', import.meta.url), 'utf8'))
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, example), mergeConfig(DEFAULT_CONFIG, {}))
})

test('effort: digabung per tahap, divalidasi, dan bisa diganti lewat --effort', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { effort: { vote: 'low' } })
  assert.deepEqual(merged.effort, { frame: '', research: '', panel: '', judge: '', vote: 'low', repair: 'low' })
  assert.deepEqual(validateConfig(merged), [])
  const bad = mergeConfig(DEFAULT_CONFIG, { effort: { vote: 'sangat-rendah', tidur: 'low' } })
  assert.equal(validateConfig(bad).length, 2)

  const { config, errors } = applyRunOptions(merged, { effort: ['judge=high', 'vote='] })
  assert.deepEqual(errors, [])
  assert.equal(config.effort.judge, 'high')
  assert.equal(config.effort.vote, '')
  assert.equal(merged.effort.judge, '')
  assert.equal(applyRunOptions(merged, { effort: ['tanpa-sama-dengan', 'x=low'] }).errors.length, 2)
})
