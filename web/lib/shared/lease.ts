// Named leases in the app_leases table, with fencing: at most one holder per name, and a holder that has lost its
// lease can no longer write.
//
// - Acquire is one atomic upsert that takes the row over only when it is free or expired, and bumps the row's
//   `generation` on every takeover. The holder's fencing token is the generation it acquired.
// - Fencing: every write made under the lease first runs, in the same transaction, an UPDATE that matches only while
//   this holder still owns the row at its own generation and the lease has not expired. No match: the write is refused
//   (StaleLeaseWrite) and its transaction rolls back. On PG that UPDATE also locks the lease row until the transaction
//   ends, so a takeover cannot land between the check and the write; on SQLite the whole transaction is one writer.
//   So a holder that paused (GC, partition, a stalled connection), lost the lease, and then resumed gets every write
//   refused, while the new holder's writes go through.
//   - fence(t): the check as a step inside a Db.tx body.
//   - fenceSqlite(raw): a view of a better-sqlite3 handle whose every write statement (and exec) is fenced, for
//     modules that still use the raw handle (the tick's work). Reads pass through.
// - A heartbeat renews the lease while the holder's process runs; keep() between steps stops the holder once its lease
//   is lost or could not be confirmed with stepBudgetMs to spare.
// What fencing cannot cover: an effect outside the store (an email accepted by Gmail) that happens between a fenced
// claim and a fenced result. Those rely on the outreach modules' claim -> send -> uncertain machinery.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'

export class LeaseLost extends Error {
  constructor(name: string, why: string) { super(`lease ${name} lost: ${why}; stopping before the next step`) }
}
export class StaleLeaseWrite extends Error {
  constructor(name: string, generation: number) { super(`write refused: lease ${name} generation ${generation} is no longer held`) }
}

export const FENCE_SQL = 'UPDATE app_leases SET generation = generation WHERE name = ? AND owner = ? AND generation = ? AND expires_at > ?'

export interface Lease {
  readonly name: string
  readonly owner: string
  readonly generation: number
  // Call between steps. Renews when due; throws LeaseLost if the lease is lost or could not be confirmed with
  // stepBudgetMs to spare.
  keep(now?: number): Promise<void>
  fence(t: Tx): TxBody<void>
  fenceSqlite(raw: Database.Database): Database.Database
  release(): Promise<void>
}

export interface LeaseOptions { ttlMs: number; stepBudgetMs: number; renewEveryMs?: number; heartbeat?: boolean; clock?: () => number }

export async function tryLease(db: Db, name: string, o: LeaseOptions, now?: number): Promise<Lease | null> {
  if (o.stepBudgetMs >= o.ttlMs) throw new Error('stepBudgetMs must be shorter than ttlMs')
  const clock = o.clock ?? Date.now
  const at0 = now ?? clock()
  const renewEvery = o.renewEveryMs ?? Math.floor((o.ttlMs - o.stepBudgetMs) / 3)
  const owner = randomBytes(12).toString('hex')
  const r = await db.get<{ owner: string; generation: number }>(
    `INSERT INTO app_leases (name, owner, expires_at, generation) VALUES (?, ?, ?, 1)
     ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at, generation = app_leases.generation + 1
       WHERE app_leases.expires_at <= ?
     RETURNING owner, generation`,
    [name, owner, at0 + o.ttlMs, at0])
  if (r?.owner !== owner) return null
  const generation = Number(r.generation)
  // expiresAt is the expiry this holder last saw confirmed in the store; it never assumes more than that.
  let expiresAt = at0 + o.ttlMs
  let renewedAt = at0
  let lost = false
  const renew = async (at: number) => {
    if (lost) return
    try {
      const u = await db.run('UPDATE app_leases SET expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END WHERE name = ? AND owner = ? AND generation = ? AND expires_at > ?',
        [at + o.ttlMs, at + o.ttlMs, name, owner, generation, at])
      if (u.changes === 1) { expiresAt = Math.max(expiresAt, at + o.ttlMs); renewedAt = at }
      else lost = true // taken over or already expired: never try to win it back
    } catch { /* store unreachable: rely only on the expiry already confirmed */ }
  }
  const timer = o.heartbeat === false ? null : setInterval(() => { void renew(clock()) }, renewEvery)
  timer?.unref()
  const refused = () => { lost = true; return new StaleLeaseWrite(name, generation) }
  // Raw SQLite check: runs inside the caller's (or a fresh) transaction on the same connection.
  const checkRaw = (raw: Database.Database) => {
    if (raw.prepare(FENCE_SQL).run(name, owner, generation, clock()).changes !== 1) throw refused()
  }
  return {
    name, owner, generation,
    async keep(at = clock()) {
      if (at - renewedAt >= renewEvery) await renew(at)
      if (lost) throw new LeaseLost(name, 'taken over or expired')
      if (expiresAt - at < o.stepBudgetMs) throw new LeaseLost(name, `less than ${o.stepBudgetMs} ms of confirmed lease left`)
    },
    *fence(t: Tx): TxBody<void> {
      if ((yield* t.run(FENCE_SQL, [name, owner, generation, clock()])).changes !== 1) throw refused()
    },
    fenceSqlite(raw: Database.Database): Database.Database {
      return fencedSqlite(raw, () => checkRaw(raw))
    },
    release: async () => {
      if (timer) clearInterval(timer)
      lost = true
      await db.run('DELETE FROM app_leases WHERE name = ? AND owner = ? AND generation = ?', [name, owner, generation])
    },
  }
}

// A view of `raw` in which every write runs as check() + the write in one transaction (a savepoint when the caller is
// already inside one). Statements that do not write (better-sqlite3's `readonly`) pass through unchanged.
// No path from the view leads back to the raw objects: every method whose result is the raw statement or the raw
// handle (fluent setters like bind/pluck/raw/expand/safeIntegers, statement.database, the handle's own fluent
// returns) gives back the fenced wrapper instead, and a pragma that sets a value is fenced like a write.
// What it cannot stop is code that never uses the view: a module that fetches the raw handle itself (getAuthDb()) is
// outside the fence. The tick's modules only read that way (lib/replies/threads.ts reads the seller profile).
function fencedSqlite(raw: Database.Database, check: () => void): Database.Database {
  const fenced = <T>(f: () => T): T => raw.transaction(() => { check(); return f() })()
  type Stmt = Database.Statement
  const statements = new WeakMap<object, Stmt>()
  // Map anything that is the raw handle or a raw statement onto its fenced counterpart.
  const remap = (v: unknown): unknown => v === raw ? view : (v && typeof v === 'object' && statements.has(v) ? statements.get(v) : v)
  const wrapStatement = (st: Stmt): Stmt => {
    const known = statements.get(st)
    if (known) return known
    // `readonly`, not `reader`: a write with RETURNING returns rows (reader) and still writes.
    const writes = !st.readonly
    // The proxy's own target is an empty object with the statement's prototype: the real statement has non-configurable
    // own properties (database), and a proxy over it could not report the view there.
    const target = st
    const proxy = new Proxy(Object.create(Object.getPrototypeOf(st)) as Stmt, {
      get(_, p) {
        if (p === 'database') return view
        const v = Reflect.get(target, p, target)
        if (typeof v !== 'function') return v
        const call = (...a: unknown[]) => remap((v as (...x: unknown[]) => unknown).apply(target, a))
        if (!writes) return call
        if (p === 'run' || p === 'get' || p === 'all') return (...a: unknown[]) => fenced(() => call(...a))
        if (p === 'iterate') return (...a: unknown[]) => fenced(() => [...(v as (...x: unknown[]) => Iterable<unknown>).apply(target, a)])[Symbol.iterator]()
        return call
      },
    })
    statements.set(st, proxy)
    return proxy
  }
  const target = raw
  const view: Database.Database = new Proxy(Object.create(Object.getPrototypeOf(raw)) as Database.Database, {
    get(_, p) {
      if (p === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql))
      if (p === 'exec') return (sql: string) => { fenced(() => target.exec(sql)); return view }
      // A pragma that assigns (user_version = 3) changes the store: the holder must still own the lease. Some pragmas
      // cannot run inside a transaction (journal_mode), so this one is checked just before, not atomically with it.
      if (p === 'pragma') return (src: string, o?: { simple?: boolean }) => { if (/=/.test(src)) check(); return target.pragma(src, o) }
      const v = Reflect.get(target, p, target)
      return typeof v === 'function' ? (...a: unknown[]) => remap((v as (...x: unknown[]) => unknown).apply(target, a)) : v
    },
  })
  return view
}
