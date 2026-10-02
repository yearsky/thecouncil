// Folder per sidang: sessions/<waktu>_<slug>/events.jsonl dan report.md.

import fs from 'node:fs'
import path from 'node:path'

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
    }
  }
}
