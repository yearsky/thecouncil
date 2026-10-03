// Folder per sidang: sessions/<waktu>_<slug>/events.jsonl dan report.md.

import fs from 'node:fs'
import path from 'node:path'
import { memoryFromEvents } from '../council/memory.js'

export function slugify(text, max = 40) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, max).replace(/-+$/, '') || 'sidang'
}

const pad = (n) => String(n).padStart(2, '0')

// Waktu lokal, aman untuk nama folder di Windows (tanpa titik dua).
export function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function createSession({ topic, baseDir = 'sessions', now = new Date() }) {
  const id = `${stamp(now)}_${slugify(topic)}`
  const dir = path.resolve(baseDir, id)
  fs.mkdirSync(dir, { recursive: true })
  const eventsPath = path.join(dir, 'events.jsonl')
  const reportPath = path.join(dir, 'report.md')
  return {
    id,
    dir,
    eventsPath,
    reportPath,
    append(event) {
      fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n')
    },
    writeReport(markdown) {
      fs.writeFileSync(reportPath, markdown)
    },
    writeMemory(memory) {
      fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(memory, null, 2))
    }
  }
}

// Memori sidang lama untuk --lanjut: memory.json kalau ada, kalau tidak disusun dari events.jsonl.
export function readMemory(sessionDir, { baseDir = 'sessions' } = {}) {
  const candidates = [path.resolve(sessionDir), path.resolve(baseDir, sessionDir)]
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'events.jsonl')) || fs.existsSync(path.join(d, 'memory.json')))
  if (!dir) throw new Error(`folder sesi "${sessionDir}" tidak ditemukan (dicari juga di ${baseDir}/)`)
  const id = path.basename(dir)
  const memoryPath = path.join(dir, 'memory.json')
  if (fs.existsSync(memoryPath)) return JSON.parse(fs.readFileSync(memoryPath, 'utf8'))
  const events = fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return memoryFromEvents(events, { id })
}
