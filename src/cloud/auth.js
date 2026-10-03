// Login sederhana untuk mode server: satu password (COUNCIL_PASSWORD) → cookie bertanda tangan HMAC,
// dan token (COUNCIL_API_TOKEN) untuk bot WhatsApp lewat header Authorization: Bearer.

import crypto from 'node:crypto'

export const COOKIE = 'council_session'
const MAX_AGE = 30 * 24 * 3600

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest()

// Perbandingan waktu-konstan; panjang disamakan lewat hash supaya panjang rahasia tidak bocor.
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b))
}

export function sessionSecret(env) {
  return env.COUNCIL_SECRET || crypto.createHmac('sha256', 'thecouncil-session').update(env.COUNCIL_PASSWORD || '').digest('hex')
}

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url')

export function makeSessionCookie(secret, { now = Date.now(), secure = true } = {}) {
  const exp = Math.floor(now / 1000) + MAX_AGE
  const value = `v1.${exp}.${sign(secret, `v1.${exp}`)}`
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`
}

export const clearSessionCookie = (secure = true) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`

export function readCookie(request, name = COOKIE) {
  const header = request.headers.get('cookie') || ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

export function validSession(secret, value, now = Date.now()) {
  const [version, exp, mac] = String(value || '').split('.')
  if (version !== 'v1' || !exp || !mac) return false
  if (Number(exp) * 1000 < now) return false
  return safeEqual(mac, sign(secret, `v1.${exp}`))
}

export function validBearer(request, token) {
  if (!token) return false
  const header = request.headers.get('authorization') || ''
  return header.startsWith('Bearer ') && safeEqual(header.slice(7), token)
}
