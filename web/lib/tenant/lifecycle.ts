// Tenant data export and deletion (issue #359; docs/TENANT-LIFECYCLE.md). The scope of "a tenant's data" is every table
// lib/tenant/scope.ts classifies as tenant-scoped (its own tenant column, or a parent chain to one); the isolation tests
// hold the live schema to that registry, so a new table cannot be missed here.
//
// Export: every row the tenant owns, table by table, with stored credentials and session/OAuth state left out or
// redacted (the export is for the tenant; it never carries a secret, a password hash or a session token).
//
// Deletion is a resumable state machine, one transaction per step, recorded in tenant_tombstones:
//   requested  the tombstone exists: from here no write can add rows for this tenant (triggers, below)
//   revoked    credentials and sign-in state deleted: Gmail tokens, LLM keys, connector secrets, sessions, OAuth
//              identities and states. (Revoking a Gmail grant at Google is a network call the operator makes; see docs.)
//   cancelled  queued work deleted (work queue rows), and the ids of every parent row (scan jobs, leads, batches,
//              monitors, watches) recorded in tenant_tombstone_keys, so a job still running cannot add children
//   erased     every tenant-scoped row deleted, children first, except tables the policy explicitly retains
//   completed  done; retained tables and their row counts are recorded on the tombstone
// A step that fails leaves the state at the last completed step; deleteTenant() again resumes there. Re-running a
// completed deletion changes nothing.
//
// Recreation guard: migrateTenantLifecycle() (lib/db/tenant-guard.ts) adds a BEFORE INSERT trigger to every tenant-scoped table refusing a row
// for a tombstoned tenant (or under a deleted parent), so in-flight jobs, a late tick or a stale request cannot bring
// erased data back. Retained tables are guarded too: nothing new is added for a deleted tenant.
//
// Backups: a restore brings back rows deleted after the backup was taken, and loses tombstones written since. The
// tombstone is also appended to an off-database ledger (tombstoneLedgerEntry; the operator stores it with the backups'
// manifests), and reapplyTombstones() re-runs every ledgered deletion on a restored store before it serves traffic.
//
// No retention policy is decided here: deleteTenant() takes the policy as an argument and refuses to run without an
// explicit decision on opt-outs (suppressions). The owner's decisions are listed in docs/TENANT-LIFECYCLE.md.
import { asDb, type DbLike, type Param, type Tx, type TxBody } from '../db/client.ts'
import { classify, type Scope } from './scope.ts'
import { tableColumns, UNGUARDED } from '../db/tenant-guard.ts'

export type DeletionState = 'requested' | 'revoked' | 'cancelled' | 'erased' | 'completed'
const ORDER: DeletionState[] = ['requested', 'revoked', 'cancelled', 'erased', 'completed']
// Credentials and sign-in state: removed first, so nothing can act as the tenant while the rest is erased.
export const CREDENTIAL_TABLES = ['sessions', 'oauth_states', 'oauth_identities', 'gmail_accounts', 'tenant_llm_keys', 'tenant_connectors']
// Left out of an export entirely (token material, no value to the tenant) and redacted columns.
export const EXPORT_EXCLUDED: Record<string, string> = { sessions: 'session tokens (hashed); never exported', oauth_states: 'one-time OAuth state and PKCE verifiers; never exported' }
export const REDACTED_COLUMN = /^(password_hash|salt|ciphertext|refresh_ct)$|secret/
// Kept whatever the policy: append-only audit records that hold no tenant content (lib/scan/evidence-copies.ts: who
// purged evidence, why, and counts). Reported on the tombstone as retained, like any policy retention.
export const ALWAYS_RETAINED: Record<string, string> = { evidence_purge_audit: 'append-only audit of evidence purges (operator, reason, counts); no tenant content' }

export interface DeletionPolicy {
  // An explicit decision on opt-outs: keep the suppression list (so the addresses are never mailed again if the
  // account is restored or recreated under the same id) or erase it with everything else.
  suppressions: 'retain' | 'erase'
  // Further tables to keep, each a tenant-scoped table named on purpose (for example billing records kept for tax).
  retainTables?: string[]
}

// The tenant-scoped tables of a live store, on either engine.
export async function tenantScope(d: DbLike): Promise<Scope[]> { return classify(await tableColumns(asDb(d))) }

// A WHERE clause selecting the tenant's rows of one table (through its parent chain), with its parameters.
function owned(scope: Map<string, Scope>, table: string, tenant: string): { sql: string; params: Param[] } {
  const s = scope.get(table)
  if (!s) throw new Error(`not a tenant-scoped table: ${table}`)
  if (s.how === 'direct') return { sql: `"${s.col}" = ?`, params: [tenant] }
  const p = owned(scope, s.parent, tenant)
  return { sql: `"${s.col}" IN (SELECT id FROM "${s.parent}" WHERE ${p.sql})`, params: p.params }
}
// Parents before children (scan_jobs, then leads, then lead_sources).
function depth(scope: Map<string, Scope>, t: string): number { const s = scope.get(t); return s?.how === 'via' ? 1 + depth(scope, s.parent) : 0 }

export interface TenantExport { format: 'dazl-tenant-export'; version: 1; tenant: string; exported_at: string; tables: Record<string, Record<string, unknown>[]>; excluded: Record<string, string>; redacted_columns: string[] }
export async function exportTenant(d: DbLike, tenant: string, now = new Date()): Promise<TenantExport> {
  const db = asDb(d)
  const scope = new Map((await tenantScope(db)).map(s => [s.table, s]))
  const tables: TenantExport['tables'] = {}
  const redacted = new Set<string>()
  const clean = (t: string, r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (REDACTED_COLUMN.test(k) && v != null) { redacted.add(`${t}.${k}`); return [k, '[redacted: stored credential]'] }
    return [k, v instanceof Uint8Array ? { base64: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? Number(v) : v]
  }))
  const profile = await db.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [tenant])
  if (profile) tables.users = [clean('users', profile)]
  for (const t of [...scope.keys()].sort()) {
    if (EXPORT_EXCLUDED[t]) continue
    const w = owned(scope, t, tenant)
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM "${t}" WHERE ${w.sql}`, w.params)
    if (rows.length) tables[t] = rows.map(r => clean(t, r))
  }
  return { format: 'dazl-tenant-export', version: 1, tenant, exported_at: now.toISOString(), tables, excluded: EXPORT_EXCLUDED, redacted_columns: [...redacted].sort() }
}

export interface Tombstone { deleted_tenant: string; requested_at: number; requested_by: string; state: DeletionState; policy: string; retained: string | null; completed_at: number | null }
export const tombstone = async (d: DbLike, tenant: string) => asDb(d).get<Tombstone>('SELECT * FROM tenant_tombstones WHERE deleted_tenant = ?', [tenant])

// The off-database record of a deletion (for the backup ledger): enough to re-apply it, no tenant data.
export function tombstoneLedgerEntry(t: Tombstone): string {
  return JSON.stringify({ kind: 'dazl-tenant-tombstone', deleted_tenant: t.deleted_tenant, requested_at: Number(t.requested_at), requested_by: t.requested_by, policy: JSON.parse(t.policy) })
}

// Workspaces (lib/workspaces.ts): the tenant is an organization, and a personal workspace's id is its founder's users.id,
// whose row also holds the workspace profile. Deleting a workspace that is shared (a team workspace, other members in
// it, or a founder who belongs to another workspace) would either delete a person still using dazl elsewhere or leave
// this workspace's profile on their account. Until the owner decides how that works, it is refused, never guessed.
async function refuseSharedWorkspace(db: ReturnType<typeof asDb>, tenant: string): Promise<void> {
  const cols = await tableColumns(db)
  if (!cols.has('organizations') || !cols.has('memberships')) return
  const org = await db.get<{ kind: string }>('SELECT kind FROM organizations WHERE id = ?', [tenant])
  if (org && org.kind !== 'personal') throw new Error('team workspaces cannot be deleted yet (docs/TENANT-LIFECYCLE.md, decision 9)')
  if (await db.get('SELECT 1 FROM memberships WHERE tenant_id = ? AND member_id <> ?', [tenant, tenant])) throw new Error('the workspace has other members: deletion refused (docs/TENANT-LIFECYCLE.md, decision 9)')
  if (await db.get('SELECT 1 FROM memberships WHERE member_id = ? AND tenant_id <> ?', [tenant, tenant])) throw new Error('the founder belongs to another workspace: deletion refused (docs/TENANT-LIFECYCLE.md, decision 9)')
}

function validPolicy(p: DeletionPolicy | undefined, scope: Map<string, Scope>): DeletionPolicy {
  if (!p || (p.suppressions !== 'retain' && p.suppressions !== 'erase')) throw new Error('deletion policy must decide suppressions: retain or erase')
  for (const t of p.retainTables ?? []) {
    if (!scope.has(t)) throw new Error(`retainTables: ${t} is not a tenant-scoped table`)
    if (CREDENTIAL_TABLES.includes(t)) throw new Error(`retainTables: ${t} holds credentials and is always deleted`)
  }
  return { suppressions: p.suppressions, retainTables: [...(p.retainTables ?? [])].sort() }
}

// Delete (or resume deleting) one tenant. `until` stops after a given state (staged deletion, and the tests' crash
// points). Returns the tombstone after the run.
export async function deleteTenant(d: DbLike, tenant: string, o: { policy?: DeletionPolicy; requestedBy?: string; now?: number; until?: DeletionState } = {}): Promise<Tombstone> {
  const db = asDb(d)
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const scope = new Map((await tenantScope(db)).map(s => [s.table, s]))
  let t = await tombstone(db, tenant)
  if (!t) {
    await refuseSharedWorkspace(db, tenant)
    const policy = validPolicy(o.policy, scope)
    if (!o.requestedBy) throw new Error('requestedBy is required (who asked, for the audit record)')
    await db.run("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES (?, ?, ?, 'requested', ?) ON CONFLICT (deleted_tenant) DO NOTHING",
      [tenant, now, o.requestedBy.slice(0, 200), JSON.stringify(policy)])
    t = (await tombstone(db, tenant))!
  }
  const policy = JSON.parse(t.policy) as DeletionPolicy
  const retain = new Set([...(policy.retainTables ?? []), ...(policy.suppressions === 'retain' ? ['suppressions'] : []), ...Object.keys(ALWAYS_RETAINED)])
  const has = (x: string) => scope.has(x)
  // One step: its statements and the state change commit together, or not at all.
  const advance = async (from: DeletionState, to: DeletionState, body: (tx: Tx) => TxBody<void>) => {
    if (ORDER.indexOf(t!.state) >= ORDER.indexOf(to)) return true
    if (o.until && ORDER.indexOf(from) >= ORDER.indexOf(o.until)) return false
    await db.tx(function* (tx) {
      yield* body(tx)
      const r = yield* tx.run('UPDATE tenant_tombstones SET state = ? WHERE deleted_tenant = ? AND state = ?', [to, tenant, from])
      if (r.changes !== 1) throw new Error(`tenant deletion: expected state ${from}, another run moved it`)
    })
    t = (await tombstone(db, tenant))!
    return true
  }
  function* del(tx: Tx, x: string): TxBody<void> { const w = owned(scope, x, tenant); yield* tx.run(`DELETE FROM "${x}" WHERE ${w.sql}`, w.params) }
  const parents = [...new Set([...scope.values()].flatMap(s => s.how === 'via' ? [s.parent] : []))].sort((a, b) => depth(scope, a) - depth(scope, b))
  const erase = [...scope.keys()].filter(x => !retain.has(x) && !UNGUARDED.has(x)).sort((a, b) => depth(scope, b) - depth(scope, a) || a.localeCompare(b))

  if (!await advance('requested', 'revoked', function* (tx) {
    for (const x of CREDENTIAL_TABLES) if (has(x)) yield* del(tx, x)
  })) return t
  if (!await advance('revoked', 'cancelled', function* (tx) {
    if (has('work_queue')) yield* del(tx, 'work_queue')
    // every parent a child row could hang off, recorded before the parents are deleted
    for (const p of parents) {
      const w = owned(scope, p, tenant)
      yield* tx.run(`INSERT INTO tenant_tombstone_keys (deleted_tenant, tbl, key) SELECT ?, ?, id FROM "${p}" WHERE ${w.sql} ON CONFLICT (tbl, key) DO NOTHING`, [tenant, p, ...w.params])
    }
  })) return t
  if (!await advance('cancelled', 'erased', function* (tx) {
    // unexpired evidence copies may only be deleted under this tenant's purge gate (lib/scan/evidence-copies.ts)
    const gate = has('evidence_purge_gate') && has('lead_evidence_copies')
    if (gate) yield* tx.run('INSERT INTO evidence_purge_gate (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING', [tenant])
    for (const x of erase) yield* del(tx, x)
    if (gate) yield* del(tx, 'evidence_purge_gate')
    yield* tx.run('DELETE FROM users WHERE id = ?', [tenant])
    if (has('memberships')) yield* tx.run('DELETE FROM organizations WHERE id = ?', [tenant])
  })) return t
  await advance('erased', 'completed', function* (tx) {
    const kept: Record<string, number> = {}
    for (const x of [...retain].sort()) if (has(x)) { const w = owned(scope, x, tenant); kept[x] = Number((yield* tx.get<{ n: number }>(`SELECT count(*) AS n FROM "${x}" WHERE ${w.sql}`, w.params))?.n ?? 0) }
    yield* tx.run('UPDATE tenant_tombstones SET retained = ?, completed_at = ? WHERE deleted_tenant = ?', [JSON.stringify(kept), now, tenant])
  })
  return t
}

// After a restore: re-apply every ledgered deletion (lines from tombstoneLedgerEntry). A restored store has the rows
// back and may lack the tombstone; each deletion is re-recorded with its original policy and run to completion.
export async function reapplyTombstones(d: DbLike, ledgerLines: string[], now?: number): Promise<{ tenant: string; state: DeletionState }[]> {
  const out: { tenant: string; state: DeletionState }[] = []
  for (const line of ledgerLines.map(l => l.trim()).filter(Boolean)) {
    const e = JSON.parse(line) as { kind: string; deleted_tenant: string; requested_at: number; requested_by: string; policy: DeletionPolicy }
    if (e.kind !== 'dazl-tenant-tombstone') throw new Error('not a tenant tombstone ledger line')
    const t = await deleteTenant(d, e.deleted_tenant, { policy: e.policy, requestedBy: `${e.requested_by} (re-applied after restore)`, now })
    out.push({ tenant: e.deleted_tenant, state: t.state })
  }
  return out
}

export type { Scope }
