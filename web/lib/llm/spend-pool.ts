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
// A pending-settlement marker this old belongs to a call whose accounting did not land (a call takes minutes at most).
export const PENDING_STALE_S = 15 * 60
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
  // removes. While any marker of the owner is older than PENDING_STALE_S, every reservation is refused
  // ('accounting_unsettled'): a paid call whose cost was never recorded stops the owner's paid calls until it is cleared.
  reserve(usd: number, nowS?: number, pendingId?: string): Promise<void>
  // delta moves the reservation (negative releases what the call did not use); reportedUsd adds the vendor's figure.
  // reservedAtS is when the reservation was made: it settles in the windows it was reserved in.
  // With pendingId the marker is removed in the same transaction; a marker already gone means this reservation was
  // settled before, and nothing moves (a retry is a no-op).
  settle(deltaUsd: number, reportedUsd: number | null, reservedAtS: number, pendingId?: string): Promise<void>
  // A call whose cost is unknown: the shortest window it was reserved in (the day when a day limit is set, else the
  // month) counts as spent up to its limit, so every later reservation in it is refused until the window turns; the
  // month keeps the call's full reservation. Throws (nothing written) when the row is missing.
  exhaust(reservedAtS: number, pendingId?: string): Promise<void>
}

function windows(limits: PoolLimits): [PoolWindow, number][] {
  const out: [PoolWindow, number][] = []
  for (const w of ['day', 'month'] as const) {
    const v = limits[w]
    if (v !== null && v !== undefined) out.push([w, v])
  }
  return out
}

export function sharedPool(d: DbLike, owner: string, limits: PoolLimits, clock: () => number = () => Math.floor(Date.now() / 1000)): SharedPool {
  const db = asDb(d)
  const ws = windows(limits)
  for (const [, v] of ws) if (!(Number.isFinite(v) && v > 0)) throw new Error('spend pool limit must be a positive number')
  return {
    owner, limits,
    now: clock,
    async reserve(usd, nowS = clock(), pendingId) {
      if (!(Number.isFinite(usd) && usd >= 0)) throw new SpendRefused('reservation_invalid')
      if (ws.length === 0 || (usd === 0 && !pendingId)) return
      const marker = pendingId === undefined ? null : pendingPeriod(pendingId)
      let ok: boolean
      try {
        ok = await db.tx(function* (t: Tx): TxBody<boolean> {
          if (yield* t.get("SELECT 1 AS k FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE 'p:%' AND updated_at <= ?", [owner, nowS - PENDING_STALE_S])) throw new SpendRefused('accounting_unsettled')
          if (marker) yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, 0, 0, ?)', [owner, marker, usd, nowS])
          for (const [w, limit] of ws) {
            const period = periodOf(w, nowS)
            yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 0, 0, 0, ?) ON CONFLICT (tenant_id, period) DO NOTHING', [owner, period, nowS])
            const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ? AND reserved_usd + ? <= ?', [usd, nowS, owner, period, usd, limit + EPS])
            // A window that does not fit: throw so the transaction rolls back every window already raised.
            if (r.changes !== 1) throw new SpendRefused('over_limit')
          }
          return true
        })
      } catch (e) {
        if (e instanceof SpendRefused) throw e
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
