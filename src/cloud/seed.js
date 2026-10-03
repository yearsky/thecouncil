// Angka acak yang bisa diulang dari seed, supaya alias "Panelis A/B/C" sama di setiap slice sidang.
import crypto from 'node:crypto'

export const newSeed = () => crypto.randomInt(1, 2 ** 31)

// mulberry32: PRNG kecil dan cukup untuk mengacak urutan alias (bukan untuk keamanan).
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
