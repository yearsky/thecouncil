import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, loadConfig, mergeConfig, validateConfig } from '../src/config.js'
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
  assert.equal(c.agents.deepseek.baseURL, 'https://api.deepseek.com')
  assert.equal(c.agents.claude.model, 'sonnet')
})

test('validateConfig menolak agen yang tidak ada', () => {
  const errors = validateConfig(mergeConfig(DEFAULT_CONFIG, { panel: ['claude', 'gemini'], moderator: { agent: 'x' } }))
  assert.deepEqual(errors, ['agen panel "gemini" tidak ada di "agents"', 'moderator "x" tidak ada di "agents"'])
})

test('loadConfig: tanpa file pakai bawaan; file dengan BOM (Notepad) tetap terbaca', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-config-'))
  assert.equal(loadConfig({ cwd: dir }).source, null)
  fs.writeFileSync(path.join(dir, 'council.config.json'), '﻿{"moderator":{"model":"opus"}}')
  const c = loadConfig({ cwd: dir })
  assert.equal(c.moderator.model, 'opus')
  assert.equal(c.source, path.join(dir, 'council.config.json'))
  assert.throws(() => loadConfig({ cwd: dir, file: 'tidak-ada.json' }), /tidak ditemukan/)
  fs.writeFileSync(path.join(dir, 'rusak.json'), '{')
  assert.throws(() => loadConfig({ cwd: dir, file: 'rusak.json' }), /Gagal membaca/)
})

test('council.config.example.json sama dengan config bawaan', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../council.config.example.json', import.meta.url), 'utf8'))
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, example), mergeConfig(DEFAULT_CONFIG, {}))
})
