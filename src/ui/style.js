// Warna ANSI sederhana (Windows Terminal & PowerShell modern mendukungnya).
// Mati otomatis jika output bukan terminal atau NO_COLOR diset.

export function createStyle(enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text))
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36')
  }
}
