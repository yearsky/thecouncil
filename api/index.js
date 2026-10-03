// Fungsi Vercel untuk semua rute /api/* (/api/<rute> ditulis ulang ke /api?path=<rute>, lihat vercel.json).
// Hanya agen API (DeepSeek) yang dipakai di sini; Claude/Codex lewat login langganan tetap hanya di PC sendiri
// (`council run` / `council ui`).

import { getDeadline, waitUntil } from '@vercel/functions'
import { createApp } from '../src/cloud/app.js'
import { cloudConfig } from '../src/cloud/config.js'
import { upstashEnv, upstashKv } from '../src/store/kv.js'

let app

function getApp() {
  if (app) return app
  const redis = upstashEnv(process.env)
  if (!redis) throw new Error('Upstash Redis belum dipasang: KV_REST_API_URL/KV_REST_API_TOKEN (atau UPSTASH_REDIS_REST_URL/_TOKEN) kosong')
  const limits = {}
  if (process.env.COUNCIL_MAX_DURATION_MS) limits.maxDurationMs = Number(process.env.COUNCIL_MAX_DURATION_MS)
  if (process.env.COUNCIL_DAILY_RUNS) limits.dailyRuns = Number(process.env.COUNCIL_DAILY_RUNS)
  app = createApp({ kv: upstashKv(redis), config: cloudConfig(process.env), waitUntil, deadline: getDeadline, limits })
  return app
}

async function handle(request) {
  try {
    return await getApp().handle(request)
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
