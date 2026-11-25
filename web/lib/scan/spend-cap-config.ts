type Env = Record<string, string | undefined>

export const HARD_CAP_CAD = 5
export const MIN_FX_CAD_PER_USD = 1.5
export const HARD_CAP_USD = HARD_CAP_CAD / MIN_FX_CAD_PER_USD
// The bound the store's CHECK holds spend_cap_usd to (HARD_CAP_USD rounded up in the 4th decimal).
export const STORE_CAP_BOUND_USD = 3.3334
// Rounding guard: amounts are doubles; a reservation that fits to within a nano-dollar fits.
// A plain decimal: digits, an optional fraction. No sign, exponent, hex, spaces, commas or unicode digits.
export const DECIMAL = /^\d{1,6}(?:\.\d{1,9})?$/

export type CapConfig = { ok: true; capCad: number; fxCadPerUsd: number; capUsd: number } | { ok: false; reason: 'cap_config_invalid' }
export function scanCapConfig(env: Env = process.env): CapConfig {
  const num = (raw: string | undefined, dflt: number): number | null => {
    if (raw === undefined || raw === '') return dflt
    if (typeof raw !== 'string' || !DECIMAL.test(raw)) return null
    const v = Number(raw)
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const cad = num(env.DAZL_SCAN_CAP_CAD, HARD_CAP_CAD)
  const fx = num(env.DAZL_SCAN_CAP_FX_CAD_PER_USD, MIN_FX_CAD_PER_USD)
  if (cad === null || fx === null) return { ok: false, reason: 'cap_config_invalid' }
  const capCad = Math.min(cad, HARD_CAP_CAD), fxCadPerUsd = Math.max(fx, MIN_FX_CAD_PER_USD)
  return { ok: true, capCad, fxCadPerUsd, capUsd: Math.min(capCad / fxCadPerUsd, HARD_CAP_USD) }
}
