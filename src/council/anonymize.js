// Panelis saling melihat sebagai "Panelis A/B/C" (urutan diacak), supaya tidak mengalah atau pilih kasih
// karena nama model. Moderator juga hanya melihat alias. Pemetaan asli hanya ada di laporan dan event.

export function assignAliases(ids, random = Math.random) {
  const order = [...ids]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return Object.fromEntries(order.map((id, i) => [id, `Panelis ${aliasLetter(i)}`]))
}

function aliasLetter(i) {
  return i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`
}

// Urutan panelis menurut alias (A, B, C, …), dipakai untuk giliran devil's advocate.
export function aliasOrder(aliases) {
  return Object.keys(aliases).sort((a, b) => aliases[a].localeCompare(aliases[b]))
}
