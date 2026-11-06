// A configured timeout must be a finite positive number of milliseconds. A non-finite or non-positive override
// (SCAN_LLM_TIMEOUT_MS=abc / Infinity / 0 / -5) must never reach the stale-running lease floor: Math.max(NaN, ...)
// would make the floor NaN and silently disable the clamp that keeps a live paid call from being reaped and
// re-run (a double bill). An invalid value falls back to the default, loudly. An unset/empty value is the default.
export function configuredTimeoutMs(raw: string | undefined, dflt: number, name: string): number {
  if (raw === undefined || raw === '') return dflt
  const v = Number(raw)
  if (Number.isFinite(v) && v > 0) return v
  console.error(`${name}=${raw} is not a finite positive number of milliseconds - using ${dflt}`)
  return dflt
}
