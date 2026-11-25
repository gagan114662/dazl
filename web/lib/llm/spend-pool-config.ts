import type { PoolLimits, PoolWindow } from './spend-pool.ts'

// Spend caps (#846 / #847): every account is capped per UTC day and per UTC month, never unlimited. Each window's
// number comes from, in order:
//   1. the account's own entry, "<owner id>:<usd>,..." (exact id match):
//        DAZL_RUN_MAX_USD_USERS         per owner per UTC day
//        DAZL_OWNER_MONTH_MAX_USD_USERS per owner per UTC month
//   2. the deployment default for every other account:
//        DAZL_OWNER_DAY_MAX_USD   (built-in default OWNER_DAY_DEFAULT_USD)
//        DAZL_OWNER_MONTH_MAX_USD (built-in default OWNER_MONTH_DEFAULT_USD)
//   3. the built-in default.
// A value must be a plain decimal above 0. Anything else (missing, empty, "0", negative, "Infinity", 1e2, 0x10, text) is not a
// limit: the next source applies, so a typo or a 0 can never mean "unlimited", and a missing setting is never zero
// either. A value above the hard ceiling (OWNER_DAY_CEILING_USD / OWNER_MONTH_CEILING_USD) is clamped to it.
// Accounts with their own entry keep the guard path they had before (PooledGuard in the runner and ownerGuarded);
// every other account is reserved at the model transport (lib/scan/spend-cap.ts reserveScanSpend, accountLimits).
export const OWNER_DAY_DEFAULT_USD = 10
export const OWNER_MONTH_DEFAULT_USD = 100
export const OWNER_DAY_CEILING_USD = 100
export const OWNER_MONTH_CEILING_USD = 1000
export const CAP_ENV = {
  day: { account: 'DAZL_RUN_MAX_USD_USERS', deployment: 'DAZL_OWNER_DAY_MAX_USD', dflt: OWNER_DAY_DEFAULT_USD, ceiling: OWNER_DAY_CEILING_USD },
  month: { account: 'DAZL_OWNER_MONTH_MAX_USD_USERS', deployment: 'DAZL_OWNER_MONTH_MAX_USD', dflt: OWNER_MONTH_DEFAULT_USD, ceiling: OWNER_MONTH_CEILING_USD },
} as const
type Env = Record<string, string | undefined>
// A plain decimal (digits, an optional fraction; surrounding spaces allowed) above 0, or null (not a limit): no sign,
// exponent, hex, "Infinity" or unicode digits (#846 review R7), as the scan cap reads its settings.
const DECIMAL = /^\d{1,9}(?:\.\d{1,9})?$/
function positiveUsd(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || !DECIMAL.test(raw.trim())) return null
  const n = Number(raw.trim())
  return Number.isFinite(n) && n > 0 ? n : null
}
// This owner's entries in a "<owner id>:<usd>,..." list (exact id match): the first VALID one (#846 review R7: "A:0,A:5"
// is 5), and whether any entry for the owner was present at all.
function ownerEntry(name: string, userId: string, env: Env): { usd: number | null; present: boolean } {
  let present = false
  for (const part of (env[name] ?? '').split(',')) {
    const i = part.lastIndexOf(':'); if (i < 0) continue
    if (part.slice(0, i).trim() !== userId) continue
    present = true
    const n = positiveUsd(part.slice(i + 1))
    if (n !== null) return { usd: n, present }
  }
  return { usd: null, present }
}
// One owner's valid entry in an operator list, clamped to its window's ceiling; null when the owner has none or it is
// not a positive number (then the deployment default applies, see windowCap).
export function ownerSetting(name: string, userId: string, env: Env): number | null {
  const n = ownerEntry(name, userId, env).usd
  if (n === null) return null
  const w = name === CAP_ENV.month.account ? CAP_ENV.month : name === CAP_ENV.day.account ? CAP_ENV.day : null
  return w ? Math.min(n, w.ceiling) : n
}
// Where a cap's number came from, for the operator's check (app/api/internal/spend-caps).
export interface CapValue {
  usd: number
  source: 'account' | 'env' | 'default'
  env: string                  // the setting the number came from (the built-in default names the setting that would override it)
  clamped: boolean             // the setting was above the ceiling and was lowered to it
  ignored: string[]            // settings that were present but not a positive number, so the next source applied
}
export function windowCap(w: PoolWindow, userId: string | null, env: Env = process.env): CapValue {
  const c = CAP_ENV[w], ignored: string[] = []
  if (userId !== null) {
    const e = ownerEntry(c.account, userId, env)
    if (e.usd !== null) return { usd: Math.min(e.usd, c.ceiling), source: 'account', env: c.account, clamped: e.usd > c.ceiling, ignored }
    if (e.present) ignored.push(c.account)
  }
  const raw = env[c.deployment]
  const n = positiveUsd(raw)
  if (n !== null) return { usd: Math.min(n, c.ceiling), source: 'env', env: c.deployment, clamped: n > c.ceiling, ignored }
  if (raw !== undefined) ignored.push(c.deployment)
  return { usd: c.dflt, source: 'default', env: c.deployment, clamped: false, ignored }
}
// The typed refusal reason of the owner pool's guard (PooledGuard.label): a reservation refused by the shared
// day/month pool is NOT a refusal by the run's own budget, and the report's stop provenance must say which.
export const OWNER_POOL_LIMIT_REASON = 'owner_pool_limit'

// Every account's limits: always both windows, never unlimited.
export function accountLimits(userId: string, env: Env = process.env): { day: number; month: number } {
  return { day: windowCap('day', userId, env).usd, month: windowCap('month', userId, env).usd }
}
// The limits of an account the operator named in DAZL_RUN_MAX_USD_USERS or DAZL_OWNER_MONTH_MAX_USD_USERS (a valid
// entry in either), for the PooledGuard path it had before; null for every other account (capped at the transport by
// accountLimits instead). A named account's other window is the deployment default, never unlimited.
export function ownerLimits(userId: string, env: Env = process.env): PoolLimits | null {
  if (ownerSetting(CAP_ENV.day.account, userId, env) === null && ownerSetting(CAP_ENV.month.account, userId, env) === null) return null
  return accountLimits(userId, env)
}
