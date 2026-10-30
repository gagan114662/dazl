// Tenant export and deletion REQUESTS (issue #359, part 2; docs/TENANT-LIFECYCLE.md "Requests"). The tenant asks;
// nothing here deletes anything. Who may carry out a deletion is an owner decision still open (decision 7), so a
// deletion request is only recorded: an operator runs it with scripts/tenant-requests.mts, which shows a dry run of
// what would be deleted and retained unless --confirm is given, and then runs lib/tenant/lifecycle.ts deleteTenant.
//   export    the tenant downloads its own data (exportTenant); each download is recorded as 'delivered'
//   deletion  pending -> withdrawn (by the tenant) | executed (by an operator) | refused (by an operator, with a note)
// A tenant has at most one pending deletion request; asking again returns it. A request never writes a tombstone,
// revokes a session or changes a row of the tenant's data. Shared workspaces are refused up front, as deleteTenant
// would refuse them (decision 9).
// The request rows are the tenant's own data: deletion erases them with everything else unless the operator's policy
// retains tenant_requests. The lasting record is the tombstone, whose requested_by names the request and operator.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { asDb, type DbLike } from '../db/client.ts'
import { deleteTenant, exportTenant, refuseSharedWorkspace, tombstone, type DeletionPolicy, type Tombstone } from './lifecycle.ts'

export function migrateTenantRequests(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('export','deletion')),
    status TEXT NOT NULL CHECK (status IN ('delivered','pending','withdrawn','executed','refused')),
    requested_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT CHECK (decided_by IS NULL OR length(decided_by) <= 200),
    note TEXT CHECK (note IS NULL OR length(note) <= 300)
  );
  CREATE INDEX IF NOT EXISTS tenant_requests_tenant ON tenant_requests (tenant_id, kind, status);`)
}

export interface TenantRequest { id: string; tenant_id: string; kind: 'export' | 'deletion'; status: 'delivered' | 'pending' | 'withdrawn' | 'executed' | 'refused'; requested_at: number; decided_at: number | null; decided_by: string | null; note: string | null }
const nowS = () => Math.floor(Date.now() / 1000)
const newId = () => `req_${randomBytes(12).toString('hex')}`
const PENDING_SQL = "SELECT * FROM tenant_requests WHERE tenant_id = ? AND kind = 'deletion' AND status = 'pending' ORDER BY requested_at LIMIT 1"

// The tenant's export, and the record that it was handed out.
export async function exportForTenant(d: DbLike, tenant: string, now = nowS()) {
  const db = asDb(d)
  const data = await exportTenant(db, tenant, new Date(now * 1000))
  await db.run("INSERT INTO tenant_requests (id, tenant_id, kind, status, requested_at, decided_at, decided_by) VALUES (?, ?, 'export', 'delivered', ?, ?, 'self-service')", [newId(), tenant, now, now])
  return data
}

// What the person types to confirm a deletion request.
export const CONFIRM_PHRASE = 'delete my account'
export type RequestRefusal = { refused: string }
export async function requestDeletion(d: DbLike, tenant: string, now = nowS()): Promise<TenantRequest | RequestRefusal> {
  const db = asDb(d)
  try { await refuseSharedWorkspace(db, tenant) } catch (e) { return { refused: e instanceof Error ? e.message : 'refused' } }
  if (await tombstone(db, tenant)) return { refused: 'this account is already being deleted' }
  return db.tx(function* (t) {
    const open = yield* t.get<TenantRequest>(PENDING_SQL, [tenant])
    if (open) return open
    const id = newId()
    yield* t.run("INSERT INTO tenant_requests (id, tenant_id, kind, status, requested_at) VALUES (?, ?, 'deletion', 'pending', ?)", [id, tenant, now])
    return (yield* t.get<TenantRequest>('SELECT * FROM tenant_requests WHERE id = ?', [id]))!
  })
}

// Only the tenant's own pending request; true when one was withdrawn.
export async function withdrawDeletion(d: DbLike, tenant: string, now = nowS()): Promise<boolean> {
  return (await asDb(d).run("UPDATE tenant_requests SET status = 'withdrawn', decided_at = ?, decided_by = 'tenant' WHERE tenant_id = ? AND kind = 'deletion' AND status = 'pending'", [now, tenant])).changes > 0
}

export async function deletionStatus(d: DbLike, tenant: string): Promise<{ pending: TenantRequest | null; last: TenantRequest | null; exports: number }> {
  const db = asDb(d)
  const pending = (await db.get<TenantRequest>(PENDING_SQL, [tenant])) ?? null
  const last = (await db.get<TenantRequest>("SELECT * FROM tenant_requests WHERE tenant_id = ? AND kind = 'deletion' ORDER BY requested_at DESC, id DESC LIMIT 1", [tenant])) ?? null
  const exports = Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM tenant_requests WHERE tenant_id = ? AND kind = 'export'", [tenant]))!.n)
  return { pending, last, exports }
}

export async function listRequests(d: DbLike, status?: TenantRequest['status']): Promise<TenantRequest[]> {
  return status ? asDb(d).all<TenantRequest>('SELECT * FROM tenant_requests WHERE status = ? ORDER BY requested_at, id', [status])
    : asDb(d).all<TenantRequest>('SELECT * FROM tenant_requests ORDER BY requested_at, id')
}

export async function refuseRequest(d: DbLike, id: string, operator: string, note: string, now = nowS()): Promise<boolean> {
  return (await asDb(d).run("UPDATE tenant_requests SET status = 'refused', decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND kind = 'deletion' AND status = 'pending'", [now, operator.slice(0, 200), note.slice(0, 300), id])).changes > 0
}

// The operator's step. Without confirm: a dry run, row counts per table that would be deleted, and nothing changes.
// With confirm: the request is marked executed and deleteTenant runs under the operator's explicit policy.
export interface ExecutePlan { request: TenantRequest; tenant: string; would_delete: Record<string, number>; policy: DeletionPolicy }
export async function executeDeletion(d: DbLike, id: string, o: { operator: string; policy: DeletionPolicy; confirm: boolean; now?: number }): Promise<{ dry_run: ExecutePlan } | { executed: Tombstone }> {
  const db = asDb(d)
  if (!o.operator?.trim()) throw new Error('operator is required (who carried it out, for the tombstone)')
  if (!o.policy || (o.policy.suppressions !== 'retain' && o.policy.suppressions !== 'erase')) throw new Error('an explicit policy is required: suppressions retain or erase (there is no default; docs/TENANT-LIFECYCLE.md)')
  const req = await db.get<TenantRequest>("SELECT * FROM tenant_requests WHERE id = ? AND kind = 'deletion'", [id])
  if (!req) throw new Error(`no deletion request ${id}`)
  if (req.status !== 'pending') throw new Error(`request ${id} is ${req.status}, not pending`)
  await refuseSharedWorkspace(db, req.tenant_id)
  if (!o.confirm) {
    const ex = await exportTenant(db, req.tenant_id)
    const would = Object.fromEntries(Object.entries(ex.tables).filter(([, rows]) => rows.length).map(([t, rows]) => [t, rows.length]))
    return { dry_run: { request: req, tenant: req.tenant_id, would_delete: would, policy: o.policy } }
  }
  const now = o.now ?? nowS()
  await db.run("UPDATE tenant_requests SET status = 'executed', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", [now, o.operator.slice(0, 200), id])
  return { executed: await deleteTenant(db, req.tenant_id, { policy: o.policy, requestedBy: `deletion request ${id} by the tenant; carried out by ${o.operator}`.slice(0, 200), now }) }
}
