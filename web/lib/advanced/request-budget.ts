// ONE atomic request budget per tenant and connector, shared by every consumer of the same upstream (#192). The previous accounting read "calls in the last hour" and then called, so two
// concurrent consumers could both read 2 of 3 and both go: 4 calls against a 3/hour limit. A reservation is now a single transaction that first takes a per-(tenant, connector) lock row
// (the upsert holds the row lock until commit on Postgres; SQLite runs one writer at a time), then counts the live reservations in the window and inserts one only if there is room.
// A reservation is made BEFORE the call and is never refunded on failure or timeout: an attempted upstream request counts. Db layer (SQLite + Postgres).
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'

export function migrateAdvBudget(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adv_budget_lock (tenant_id TEXT NOT NULL, connector TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, connector));
    CREATE TABLE IF NOT EXISTS adv_requests (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connector TEXT NOT NULL, at INTEGER NOT NULL, consumer TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS adv_requests_window ON adv_requests (tenant_id, connector, at);`)
}

export const WINDOW_S = 3600
let seq = 0
export async function reserveRequest(db: Db, tenantId: string, connector: string, limit: number, consumer: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const id = `${now.toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return db.tx(function* (t: Tx): TxBody<boolean> {
    // The first reservation for a tenant/connector (n = 1 after the upsert; the row lock makes exactly one transaction see it) SNAPSHOTS the legacy usage: every audit row in the window becomes a
    // reservation row ('legacy:<audit id>', consumer 'legacy') in this same transaction, whatever its second-resolution timestamp (including one equal to now). From then on the budget counts
    // ONLY adv_requests, so legacy usage + new in-flight/unrefunded requests are summed, a request is never counted in both stores (post-cutover audit rows are never read), and there is no
    // timestamp boundary to get wrong. The legacy rows age out of the window like any reservation.
    yield* t.run('INSERT INTO adv_budget_lock (tenant_id, connector, n, since) VALUES (?, ?, 1, ?) ON CONFLICT (tenant_id, connector) DO UPDATE SET n = adv_budget_lock.n + 1', [tenantId, connector, now])
    const lock = yield* t.get<{ n: number }>('SELECT n FROM adv_budget_lock WHERE tenant_id = ? AND connector = ?', [tenantId, connector])
    if (Number(lock?.n ?? 0) === 1) yield* t.run("INSERT INTO adv_requests (id, tenant_id, connector, at, consumer) SELECT 'legacy:' || id, tenant_id, connector, created_at, 'legacy' FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status IN ('ok','empty','worker_error','error') AND created_at > ? ON CONFLICT (id) DO NOTHING", [tenantId, connector, now - WINDOW_S])
    const r = yield* t.get<{ n: number }>('SELECT COUNT(*) AS n FROM adv_requests WHERE tenant_id = ? AND connector = ? AND at > ?', [tenantId, connector, now - WINDOW_S])
    if (Number(r?.n ?? 0) >= limit) return false
    yield* t.run('INSERT INTO adv_requests (id, tenant_id, connector, at, consumer) VALUES (?, ?, ?, ?, ?)', [id, tenantId, connector, now, consumer])
    yield* t.run('DELETE FROM adv_requests WHERE tenant_id = ? AND connector = ? AND at <= ?', [tenantId, connector, now - 2 * WINDOW_S])
    return true
  })
}
export async function requestsInWindow(db: Db, tenantId: string, connector: string, now = Math.floor(Date.now() / 1000)): Promise<number> {
  return Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM adv_requests WHERE tenant_id = ? AND connector = ? AND at > ?', [tenantId, connector, now - WINDOW_S]))?.n ?? 0)
}
