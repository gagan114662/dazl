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

// Operator settings, same format as before ("<owner id>:<usd>,..."; exact id match; a malformed entry is ignored):
//   DAZL_RUN_MAX_USD_USERS         per owner per UTC day (was: per process lifetime, reset on restart)
//   DAZL_OWNER_MONTH_MAX_USD_USERS per owner per UTC month
export function ownerSetting(name: string, userId: string, env: Record<string, string | undefined>): number | null {
  for (const part of (env[name] ?? '').split(',')) {
    const i = part.lastIndexOf(':'); if (i < 0) continue
    if (part.slice(0, i).trim() !== userId) continue
    const n = Number(part.slice(i + 1).trim()); return Number.isFinite(n) && n > 0 ? n : null
  }
  return null
}
export function ownerLimits(userId: string, env: Record<string, string | undefined> = process.env): PoolLimits | null {
  const day = ownerSetting('DAZL_RUN_MAX_USD_USERS', userId, env), month = ownerSetting('DAZL_OWNER_MONTH_MAX_USD_USERS', userId, env)
  return day === null && month === null ? null : { day, month }
}

export function migrateSpendPools(db: { exec(sql: string): unknown }): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_spend_pools (
    tenant_id TEXT NOT NULL, period TEXT NOT NULL CHECK (length(period) <= 12),
    reserved_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0), reported_usd REAL NOT NULL DEFAULT 0 CHECK (reported_usd >= 0),
    calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, period)
  )`)
}
