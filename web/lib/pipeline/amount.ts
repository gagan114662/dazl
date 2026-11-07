// Parses the deal amount typed in the pipeline UI into integer minor units (#366).
// '' -> null (a deliberate clear); anything not a finite number >= 0 -> 'invalid', so garbage never reaches the
// server as JSON null (NaN serialises to null) and silently clears a stored amount.
export function parseAmountInput(raw: string): number | null | 'invalid' {
  const t = raw.trim()
  if (t === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'invalid'
  const n = Math.round(Number(t) * 100)
  return Number.isSafeInteger(n) ? n : 'invalid'
}
