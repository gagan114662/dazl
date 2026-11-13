// Workspace spend pools in the shared store (#363): one row per owner per UTC day and per UTC month, reserved before a
// paid call and moved to the vendor-reported cost after it. Replaces the per-process ownerPool Map, so a restart, a
// retry, a second job or a second instance draws on the same limit and can never reset it.
//
// A reservation is one transaction over every window it must fit: each row is created at zero if missing, then raised
// only WHERE reserved_usd + usd <= limit. On Postgres the UPDATE takes the row lock and re-checks the condition against
// the committed value, so concurrent reservations from any number of processes never pass the limit together; on
// SQLite the Db layer's transaction is IMMEDIATE (one writer). Any window that does not fit refuses the whole
// reservation and nothing is written.
//
// Columns keep estimates and vendor-reported totals apart:
//   reserved_usd - the authority: reservations (worst-case estimates) plus settled costs; what the limit is checked against
//   reported_usd - the sum of costs the vendor itself reported for settled calls (a billed figure, never an estimate)
//   calls        - reservations admitted
// On the Db layer (both engines). Tenant scope: every statement is keyed by the owner id it was given.
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'
import { SpendRefused } from './spend-guard.ts'

export type PoolWindow = 'day' | 'month'
export interface PoolLimits { day?: number | null; month?: number | null }
export interface PoolRow { tenant_id: string; period: string; reserved_usd: number; reported_usd: number; calls: number; updated_at: number }

export function periodOf(w: PoolWindow, nowS: number): string {
  const iso = new Date(nowS * 1000).toISOString()
  return w === 'day' ? `d:${iso.slice(0, 10)}` : `m:${iso.slice(0, 7)}`
}

// Rounding guard: amounts are stored as doubles; a reservation that fits to within a nano-dollar fits.
const EPS = 1e-9
// A pending-settlement marker this old belongs to a call whose accounting did not land: a completion times out after
// 150 s (SCAN_LLM_TIMEOUT_MS) plus a token count, so a live call's marker is never this old. A marker whose settle is
// KNOWN to have failed is marked at once (markFailed: updated_at 0), so it refuses without waiting.
export const PENDING_STALE_S = 5 * 60
// Failure marks this process could not write yet (the store was down), per store and owner. Every reservation of that
// owner in this process first writes them and refuses until it can; a background retry writes them as soon as the store
// answers, so other instances are stopped too. Lost on a restart: the marker itself stays and refuses once stale.
const unflushed = new WeakMap<object, Map<string, Set<string>>>()
const RETRY_MS = 5_000
// How long a reservation waits for another call of the same owner to settle before it is refused ('busy').
export const BUSY_WAIT_MS = 10_000
const BUSY_POLL_MS = 100
function pendingMarks(d: object, owner: string): Set<string> {
  let byOwner = unflushed.get(d); if (!byOwner) { byOwner = new Map(); unflushed.set(d, byOwner) }
  let set = byOwner.get(owner); if (!set) { set = new Set(); byOwner.set(owner, set) }
  return set
}
const pendingPeriod = (id: string) => {
  if (!/^[0-9a-f]{10}$/.test(id)) throw new Error('spend pool: invalid pending id')
  return `p:${id}`
}

export interface SharedPool {
  readonly owner: string
  readonly limits: PoolLimits
  // The pool's clock (epoch seconds): the one time source for which day and month a reservation lands in.
  now(): number
  // pendingId: also write a pending-settlement marker (period 'p:<id>') that only this reservation's settle or exhaust
  // removes. One unsettled call per owner: while any marker of the owner exists, every reservation (any guard, path or
  // instance) is refused. A fresh marker (a call in flight) is waited on for up to busyWaitMs, then 'busy'; a stale one
  // (a crash) or one marked failed refuses with 'accounting_unsettled' until an operator clears it. The marker carries no
  // cost of its own: clearing it leaves every reservation in the windows as it is.
  reserve(usd: number, nowS?: number, pendingId?: string, busyUntilMs?: number): Promise<void>
  // delta moves the reservation (negative releases what the call did not use); reportedUsd adds the vendor's figure.
  // reservedAtS is when the reservation was made: it settles in the windows it was reserved in.
  // With pendingId the marker is removed in the same transaction; a marker already gone means this reservation was
  // settled before, and nothing moves (a retry is a no-op).
  settle(deltaUsd: number, reportedUsd: number | null, reservedAtS: number, pendingId?: string): Promise<void>
  // A call whose cost is unknown: the shortest window it was reserved in (the day when a day limit is set, else the
  // month) counts as spent up to its limit, so every later reservation in it is refused until the window turns; the
  // month keeps the call's full reservation. Throws (nothing written) when the row is missing.
  exhaust(reservedAtS: number, pendingId?: string): Promise<void>
  // This reservation's settle is known to have failed: mark its marker so every guard, path and instance refuses now.
  // If the store does not take the write, it is kept and retried (see unflushed); never throws.
  markFailed(pendingId: string): Promise<void>
  // Write this process's unwritten failure marks for the owner; false when the store still does not take them.
  flushFailed(): Promise<boolean>
}

function windows(limits: PoolLimits): [PoolWindow, number][] {
  const out: [PoolWindow, number][] = []
  for (const w of ['day', 'month'] as const) {
    const v = limits[w]
    if (v !== null && v !== undefined) out.push([w, v])
  }
  return out
}

export function sharedPool(d: DbLike, owner: string, limits: PoolLimits, clock: () => number = () => Math.floor(Date.now() / 1000), busyWaitMs = BUSY_WAIT_MS): SharedPool {
  const db = asDb(d)
  const ws = windows(limits)
  for (const [, v] of ws) if (!(Number.isFinite(v) && v > 0)) throw new Error('spend pool limit must be a positive number')
  const marks = pendingMarks(d as object, owner)
  const flush = async (): Promise<boolean> => {
    for (const m of [...marks]) {
      try { await db.run('UPDATE tenant_spend_pools SET updated_at = 0 WHERE tenant_id = ? AND period = ?', [owner, m]) } catch { return false }
      marks.delete(m)
    }
    return true
  }
  let timer: ReturnType<typeof setInterval> | null = null
  const retryLater = () => {
    if (timer) return
    timer = setInterval(() => { void flush().then(ok => { if (ok && timer) { clearInterval(timer); timer = null } }) }, RETRY_MS)
    timer.unref?.()
  }
  return {
    owner, limits,
    now: clock,
    async markFailed(pendingId) {
      marks.add(pendingPeriod(pendingId))
      if (!(await flush())) retryLater()
    },
    flushFailed: flush,
    async reserve(usd, nowS = clock(), pendingId, busyUntil = Date.now() + busyWaitMs) {
      if (!(Number.isFinite(usd) && usd >= 0)) throw new SpendRefused('reservation_invalid')
      if (ws.length === 0 || (usd === 0 && !pendingId)) return
      // A known accounting failure this process could not record yet: record it first, or refuse.
      if (marks.size > 0 && !(await flush())) throw new SpendRefused('accounting_unsettled')
      const marker = pendingId === undefined ? null : pendingPeriod(pendingId)
      let ok: boolean
      try {
        ok = await db.tx(function* (t: Tx): TxBody<boolean> {
          for (const [w, limit] of ws) {
            const period = periodOf(w, nowS)
            yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 0, 0, 0, ?) ON CONFLICT (tenant_id, period) DO NOTHING', [owner, period, nowS])
            const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ? AND reserved_usd + ? <= ?', [usd, nowS, owner, period, usd, limit + EPS])
            // A window that does not fit: throw so the transaction rolls back every window already raised.
            if (r.changes !== 1) throw new SpendRefused('over_limit')
          }
          // Checked under the window row locks (Postgres: held to commit; SQLite: one writer), so a racing reservation
          // has either committed its marker (seen here) or waits for this one. Any unsettled marker of the owner refuses:
          // a stale or failed one until it is cleared, a fresh one (a call in flight) for now.
          const open = yield* t.get<{ oldest: number | string }>("SELECT MIN(updated_at) AS oldest FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE 'p:%' HAVING COUNT(*) > 0", [owner])
          if (open) throw new SpendRefused(Number(open.oldest) <= nowS - PENDING_STALE_S ? 'accounting_unsettled' : 'busy')
          if (marker) yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, 0, 0, ?)', [owner, marker, usd, nowS])
          return true
        })
      } catch (e) {
        if (e instanceof SpendRefused) {
          // Another paid call of this owner is in flight: wait for it to settle, for a bounded time.
          if (e.reason === 'busy' && Date.now() < busyUntil) { await new Promise(r => setTimeout(r, BUSY_POLL_MS)); return this.reserve(usd, clock(), pendingId, busyUntil) }
          throw e
        }
        // The store did not answer: no reservation exists, so the paid call must not happen (fail closed).
        throw new SpendRefused('reservation_not_saved')
      }
      if (!ok) throw new SpendRefused('over_limit')
    },
    async settle(deltaUsd, reportedUsd, reservedAtS, pendingId) {
      const nowS = clock()
      if (ws.length === 0) return
      const delta = Number.isFinite(deltaUsd) ? deltaUsd : 0
      const rep = reportedUsd !== null && Number.isFinite(reportedUsd) && reportedUsd > 0 ? reportedUsd : 0
      const marker = pendingId === undefined ? null : pendingPeriod(pendingId)
      if (delta === 0 && rep === 0 && !marker) return
      // The windows of the reservation's own time: a call that started before midnight settles on the day it was reserved
      // in. Money already spent is recorded even past the limit (later reservations are then refused); never below zero.
      const at = Number.isFinite(reservedAtS) ? reservedAtS : nowS
      // Every window row must exist (the reservation created it): a settle that changes nothing throws and rolls back
      // the windows already moved, so it is never a silent no-op.
      await db.tx(function* (t: Tx): TxBody<void> {
        if (marker && (yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [owner, marker])).changes !== 1) return
        if (delta === 0 && rep === 0) return
        for (const [w] of ws) {
          const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd + ? < 0 THEN 0 ELSE reserved_usd + ? END, reported_usd = reported_usd + ?, updated_at = ? WHERE tenant_id = ? AND period = ?',
            [delta, delta, rep, nowS, owner, periodOf(w, at)])
          if (r.changes !== 1) throw new Error('spend pool settle: window row missing')
        }
      })
    },
    async exhaust(reservedAtS, pendingId) {
      const nowS = clock()
      if (ws.length === 0) return
      const at = Number.isFinite(reservedAtS) ? reservedAtS : nowS
      const marker = pendingId === undefined ? null : pendingPeriod(pendingId)
      await db.tx(function* (t: Tx): TxBody<void> {
        if (marker && (yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [owner, marker])).changes !== 1) return
        for (const [w, limit] of ws.slice(0, 1)) {
          const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd < ? THEN ? ELSE reserved_usd END, updated_at = ? WHERE tenant_id = ? AND period = ?',
            [limit, limit, nowS, owner, periodOf(w, at)])
          if (r.changes !== 1) throw new Error('spend pool exhaust: window row missing')
        }
      })
    },
  }
}

export async function poolRows(d: DbLike, owner: string): Promise<PoolRow[]> {
  return asDb(d).all<PoolRow>('SELECT tenant_id, period, reserved_usd, reported_usd, calls, updated_at FROM tenant_spend_pools WHERE tenant_id = ? ORDER BY period', [owner])
}

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

// One reservation on an owner's windows inside a caller's transaction (lib/scan/spend-cap.ts, the transport path).
// Each window row is created at zero if missing and raised only WHERE it still fits; a window that does not fit
// undoes the windows already raised in this same transaction (under their row locks) and returns false, so the
// caller can record its refusal and commit. Nothing is written for 0 USD.
export function* reservePoolWindows(t: Tx, owner: string, limits: PoolLimits, usd: number, nowS: number): TxBody<boolean> {
  if (!(Number.isFinite(usd) && usd >= 0)) return false
  if (usd === 0) return true
  const raised: string[] = [], created: string[] = []
  for (const [w, limit] of windows(limits)) {
    const period = periodOf(w, nowS)
    if ((yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 0, 0, 0, ?) ON CONFLICT (tenant_id, period) DO NOTHING', [owner, period, nowS])).changes === 1) created.push(period)
    const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ? AND reserved_usd + ? <= ?', [usd, nowS, owner, period, usd, limit + EPS])
    if (r.changes !== 1) {
      for (const p of raised) yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd - ? < 0 THEN 0 ELSE reserved_usd - ? END, calls = calls - 1 WHERE tenant_id = ? AND period = ?', [usd, usd, owner, p])
      // A refusal leaves the store as it found it: a window row this reservation created goes again.
      for (const p of created) yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ? AND calls = 0', [owner, p])
      return false
    }
    raised.push(period)
  }
  return true
}
// Undo a reservePoolWindows that returned true, in the same transaction (the caller's own step refused after it).
export function* releasePoolWindows(t: Tx, owner: string, limits: PoolLimits, usd: number, atS: number): TxBody<void> {
  if (!(Number.isFinite(usd) && usd > 0)) return
  for (const [w] of windows(limits)) {
    const period = periodOf(w, atS)
    yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd - ? < 0 THEN 0 ELSE reserved_usd - ? END, calls = calls - 1 WHERE tenant_id = ? AND period = ?', [usd, usd, owner, period])
    // a window row left with nothing in it (this reservation made it, or it was this call alone) goes, so a refused call changes nothing (XHawk on #1154)
    yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ? AND calls <= 0 AND reserved_usd <= 0 AND reported_usd <= 0', [owner, period])
  }
}
// Move a reservation made at atS by delta (to the vendor-reported cost) in every window it was made in; reported adds
// the vendor's own figure. Never below zero; an overrun is recorded past the limit (later reservations then refuse).
export function* settlePoolWindows(t: Tx, owner: string, limits: PoolLimits, delta: number, reported: number, atS: number, nowS: number): TxBody<void> {
  const d = Number.isFinite(delta) ? delta : 0, rep = Number.isFinite(reported) && reported > 0 ? reported : 0
  if (d === 0 && rep === 0) return
  for (const [w] of windows(limits)) {
    const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd + ? < 0 THEN 0 ELSE reserved_usd + ? END, reported_usd = reported_usd + ?, updated_at = ? WHERE tenant_id = ? AND period = ?',
      [d, d, rep, nowS, owner, periodOf(w, atS)])
    // the reserved window row must still be there (XHawk on #1154): a missing row is an accounting failure, never a silent success; the transaction
    // rolls back, the hold keeps its worst case and the caller records the failure
    if (r.changes !== 1) throw new Error('spend_pool_window_missing')
  }
}

export function migrateSpendPools(db: { exec(sql: string): unknown }): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_spend_pools (
    tenant_id TEXT NOT NULL, period TEXT NOT NULL CHECK (length(period) <= 12),
    reserved_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0), reported_usd REAL NOT NULL DEFAULT 0 CHECK (reported_usd >= 0),
    calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, period)
  )`)
}
