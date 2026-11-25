// Temporary owner-authorized QA policy. UTC account days; protection lasts through
// the end of November 27 in America/New_York (November 28 05:00 UTC).
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'
import type { PoolLimits } from './spend-pool.ts'
import { SpendRefused } from './spend-guard.ts'
import { accountLimits } from './spend-pool-config.ts'

export const QA_ACCOUNT_CAP_END_S = Date.parse('2026-11-28T05:00:00Z') / 1_000
export const QA_ACCOUNT_DAY_USD = 1

export function* qaAccountProtected(t: Tx, owner: string, nowS: number): TxBody<boolean> {
  const configured = (process.env.DAZL_TRIAL_QA_EXEMPT ?? '').split(',')
    .map(s => s.trim().toLowerCase()).filter(s => s.includes('@') && !s.includes('*'))
  if (!configured.length) return false
  if (!Number.isSafeInteger(nowS) || nowS < 0) throw new SpendRefused('reservation_invalid')
  if (nowS >= QA_ACCOUNT_CAP_END_S) return false
  // Never trust the request, session label or a QA flag. Resolve the exact mailbox
  // using the canonical server store inside the reservation transaction.
  const user = yield* t.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [owner])
  return !!user && configured.includes(String(user.email).trim().toLowerCase())
}

export function* qaAccountLimits(t: Tx, owner: string, limits: PoolLimits, nowS: number): TxBody<PoolLimits> {
  if (!(yield* qaAccountProtected(t, owner, nowS))) return limits
  return { ...limits, day: Math.min(limits.day ?? QA_ACCOUNT_DAY_USD, QA_ACCOUNT_DAY_USD) }
}

export async function effectiveAccountLimits(d: DbLike, userId: string, nowS = Math.floor(Date.now() / 1_000)): Promise<PoolLimits> {
  const limits = accountLimits(userId)
  if (!(process.env.DAZL_TRIAL_QA_EXEMPT ?? '').trim()) return limits
  return asDb(d).tx(function* (t: Tx): TxBody<PoolLimits> {
    return yield* qaAccountLimits(t, userId, limits, nowS)
  })
}

export async function qaNativeSpendBlocked(db: DbLike, owner: string, nowS = Math.floor(Date.now() / 1_000)): Promise<boolean> {
  if (!(process.env.DAZL_TRIAL_QA_EXEMPT ?? '').trim()) return false
  return asDb(db).tx(function* (t: Tx): TxBody<boolean> { return yield* qaAccountProtected(t, owner, nowS) })
}
