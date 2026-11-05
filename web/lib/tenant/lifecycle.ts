// Tenant data export and deletion (issue #359; docs/TENANT-LIFECYCLE.md). The scope of "a tenant's data" is every table
// lib/tenant/scope.ts classifies as tenant-scoped (its own tenant column, or a parent chain to one); the isolation tests
// hold the live schema to that registry, so a new table cannot be missed here.
//
// Export: every row the tenant owns, table by table, with stored credentials and session/OAuth state left out or
// redacted (the export is for the tenant; it never carries a secret, a password hash or a session token).
//
// Deletion is a resumable state machine, one transaction per step, recorded in tenant_tombstones:
//   requested  the tombstone exists: from here no write can add rows for this tenant (triggers, below) except
//              this flow's own closing audit events (audit_closing_gate, below)
//   revoked    credentials and sign-in state deleted: Gmail tokens, LLM keys, connector secrets, sessions, OAuth
//              identities and states. (Revoking a Gmail grant at Google is a network call the operator makes; see docs.)
//   cancelled  queued work deleted (work queue rows), and the ids of every parent row (scan jobs, leads, batches,
//              monitors, watches) recorded in tenant_tombstone_keys, so a job still running cannot add children
//   erased     every tenant-scoped row deleted, children first, except tables the policy explicitly retains
//   completed  done; retained tables and their row counts are recorded on the tombstone
// A step that fails leaves the state at the last completed step; deleteTenant() again resumes there. Re-running a
// completed deletion changes nothing.
//
// Recreation guard: migrateTenantLifecycle() (lib/db/tenant-guard.ts) adds to every tenant-scoped table a BEFORE INSERT
// trigger and a BEFORE UPDATE OF <tenant column / parent key> trigger refusing a row for a tombstoned tenant (or under a
// deleted parent), so in-flight jobs, a late tick, a stale request or an ownership reassignment cannot bring erased data
// back or move another tenant's row under the deleted one. Retained tables are guarded too: nothing new is added or
// moved in for a deleted tenant.
//
// Backups: a restore brings back rows deleted after the backup was taken, and loses tombstones written since.
// tombstoneLedgerEntry() is the off-database record of a deletion and reapplyTombstones() re-runs every ledgered
// deletion on a restored store. The request flow writes the line (lib/tenant/ledger.ts) before any data step, and the
// recovery plan re-applies it (scripts/tenant-lifecycle.mts --reapply; docs/TENANT-LIFECYCLE.md, docs/RECOVERY.md).
//
// No retention policy is decided here: deleteTenant() takes the policy as an argument and refuses to run without an
// explicit decision on opt-outs (suppressions). The owner's decisions are listed in docs/TENANT-LIFECYCLE.md.
import { asDb, type DbLike, type Param, type Tx, type TxBody } from '../db/client.ts'
import { classify, type Scope } from './scope.ts'
import { foreignKeys, tableColumns, UNGUARDED } from '../db/tenant-guard.ts'
import { recordTx } from '../audit.ts'
import { displayAuditDetail } from '../outreach/lifecycle.ts'

export type DeletionState = 'requested' | 'revoked' | 'cancelled' | 'erased' | 'completed'
const ORDER: DeletionState[] = ['requested', 'revoked', 'cancelled', 'erased', 'completed']
// Credentials and sign-in state: removed first, so nothing can act as the tenant while the rest is erased.
export const CREDENTIAL_TABLES = ['sessions', 'oauth_states', 'oauth_identities', 'gmail_accounts', 'tenant_llm_keys', 'tenant_connectors']
// Left out of an export entirely (token material, no value to the tenant) and redacted columns.
export const EXPORT_EXCLUDED: Record<string, string> = { sessions: 'session tokens (hashed); never exported', oauth_states: 'one-time OAuth state and PKCE verifiers; never exported' }
export const REDACTED_COLUMN = /^(password_hash|salt|ciphertext|refresh_ct|token_hash|claim_token)$|secret/
// Kept whatever the policy: append-only audit records that hold no tenant content (lib/scan/evidence-copies.ts: who
// purged evidence, why, and counts). Reported on the tombstone as retained, like any policy retention.
export const ALWAYS_RETAINED: Record<string, string> = {
  evidence_purge_audit: 'append-only audit of evidence purges (operator, reason, counts); no tenant content',
  audit_events: 'append-only audit trail (lib/audit.ts); redacted at the source, and its delete trigger would refuse the erase anyway',
  onboarding_audit: 'append-only opt-in/withdrawal/enrollment evidence (lib/outreach/onboarding-policy.ts); content-free at the source (no emails), and its delete trigger would refuse the erase anyway',
}

// Row counts per tenant-owned table for one tenant: the request UI's scope inventory (what an export or a
// deletion covers), same ownership resolution the deletion itself uses.
export async function tenantTableCounts(d: DbLike, tenant: string): Promise<Record<string, number>> {
  const db = asDb(d)
  const scope = new Map((await tenantScope(db)).map(s => [s.table, s]))
  const counts: Record<string, number> = {}
  for (const t of [...scope.keys()].sort()) {
    const w = owned(scope, t, tenant)
    const n = Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM "${t}" WHERE ${w.sql}`, w.params))?.n ?? 0)
    if (n > 0) counts[t] = n
  }
  return counts
}

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
  // Conversion-kind-bearing text at tenant-readable columns. Values are generalized at export
  // (converted_<kind> -> policy_stop, conversion:<kind> -> conversion) and the column is listed in
  // redacted_columns, so the export discloses the redaction instead of claiming to be verbatim.
  // The stored rows are internal evidence and are never rewritten.
  const CONVERSION_TEXT_COLUMNS: Record<string, Set<string>> = {
    sequences: new Set(['stop_reason']),
    followup_threads: new Set(['stopped']),
    outreach_messages: new Set(['error']),
    onboarding_enrollments: new Set(['source']),
    onboarding_audit: new Set(['detail']),
    autopilot_audit: new Set(['detail']),
  }
  const clean = (t: string, r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (REDACTED_COLUMN.test(k) && v != null) { redacted.add(`${t}.${k}`); return [k, '[redacted: stored credential]'] }
    if (CONVERSION_TEXT_COLUMNS[t]?.has(k) && typeof v === 'string') {
      const mapped = displayAuditDetail(v)
      if (mapped !== v) { redacted.add(`${t}.${k}`); v = mapped }
    }
    return [k, v instanceof Uint8Array ? { base64: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? Number(v) : v]
  }))
  const profile = await db.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [tenant])
  if (profile) tables.users = [clean('users', profile)]
  // the workspace row (organizations.id is the tenant id; classified global because the id is the tenant, not a column)
  const org = (await tableColumns(db)).has('organizations') ? await db.get<Record<string, unknown>>('SELECT * FROM organizations WHERE id = ?', [tenant]) : undefined
  if (org) tables.organizations = [clean('organizations', org)]
  for (const t of [...scope.keys()].sort()) {
    if (EXPORT_EXCLUDED[t]) continue
    const w = owned(scope, t, tenant)
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM "${t}" WHERE ${w.sql}`, w.params)
    if (rows.length) tables[t] = rows.map(r => clean(t, r))
  }
  return { format: 'dazl-tenant-export', version: 1, tenant, exported_at: now.toISOString(), tables, excluded: EXPORT_EXCLUDED, redacted_columns: [...redacted].sort() }
}

// The deletion's own closing events, the only rows a tombstoned tenant may still gain: the audit_events INSERT guard
// (lib/db/tenant-guard.ts) allows one only while the tenant's audit_closing_gate row exists, and it exists inside the
// transaction that writes the event (inserted before, deleted after; a rolled-back step leaves neither). The actor is
// who asked for the deletion; the kind is service, the lifecycle machine acting on that request.
export function* closingEventTx(tx: Tx, tenant: string, requestedBy: string, action: string, now: number, summary?: Record<string, unknown>): TxBody<void> {
  // Lock order is advisory -> gate -> event for every caller. A deletion step already holds the tenant's advisory
  // lock exclusively (this re-takes it, re-entrant); the request transaction takes it here, before the gate, so
  // either side waiting on the other does so BEFORE any gate row exists - the other order (gate first, then the
  // audit guard's shared advisory on the event insert) deadlocked a request against a step on Postgres (CI
  // test-postgres on 32290eee): request held the gate row wanting the lock, step held the lock wanting the gate row.
  // The lock is SHARED here, not exclusive: shared orders against a step's exclusive lock just the same (the wait
  // happens before the gate row), but it does not conflict with the shared locks of the tenant's ordinary in-flight
  // writers, which must not delay RECORDING the request - waiting for them is the steps' job
  // (test/tenant-lifecycle-race.test.ts pins: the tombstone is written promptly, no step has run).
  if (tx.kind === 'pg') yield* tx.get('SELECT pg_advisory_xact_lock_shared(hashtext(?))', [tenant])
  yield* tx.run('INSERT INTO audit_closing_gate (tenant) VALUES (?)', [tenant])
  yield* recordTx(tx, { tenantId: tenant, actorId: requestedBy, actorKind: 'service', action, resourceType: 'tenant', resourceId: tenant, summary }, now)
  yield* tx.run('DELETE FROM audit_closing_gate WHERE tenant = ?', [tenant])
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
// Runs with the tombstone, then again inside the first step (before anything is revoked) and the erase step. App
// writes are READ COMMITTED, so a membership insert that straddles the tombstone is not refused by isolation; it is
// waited for (the step holds the tenant's advisory lock, which that insert's guard shares) and then found by the
// re-check: the deletion stops at 'requested' with nothing revoked, or at 'cancelled' if it arrives later, for the
// operator to resolve and resume.
function* refuseSharedWorkspace(tx: Tx, cols: Map<string, string[]>, tenant: string): TxBody<void> {
  if (!cols.has('organizations') || !cols.has('memberships')) return
  const org = yield* tx.get<{ kind: string }>('SELECT kind FROM organizations WHERE id = ?', [tenant])
  if (org && org.kind !== 'personal') throw new Error('team workspaces cannot be deleted yet (docs/TENANT-LIFECYCLE.md, decision 9)')
  if (yield* tx.get('SELECT 1 FROM memberships WHERE tenant_id = ? AND member_id <> ?', [tenant, tenant])) throw new Error('the workspace has other members: deletion refused (docs/TENANT-LIFECYCLE.md, decision 9)')
  if (yield* tx.get('SELECT 1 FROM memberships WHERE member_id = ? AND tenant_id <> ?', [tenant, tenant])) throw new Error('the founder belongs to another workspace: deletion refused (docs/TENANT-LIFECYCLE.md, decision 9)')
}

// What a retention policy cannot keep, because deleting something else removes or rewrites the retained rows: a
// parent-scoped table whose parent is not retained (the parent's deletion takes its rows), or a foreign key whose ON
// DELETE action (CASCADE, SET NULL, SET DEFAULT) fires from a table that is deleted. Credential tables, users and
// organizations are always deleted, so nothing can depend on them and be kept. Empty = the policy is satisfiable as
// written; deletion refuses otherwise, before any tombstone or delete (never a silent widening of the retention).
export function retentionProblems(scope: Map<string, Scope>, fks: { table: string; column: string; ref: string; onDelete: string }[], retain: Set<string>): string[] {
  const out: string[] = []
  const alwaysDeleted = (t: string) => CREDENTIAL_TABLES.includes(t) || t === 'users' || t === 'organizations'
  for (const t of [...retain].sort()) {
    const s = scope.get(t)
    const deps: { on: string; how: string }[] = []
    if (s?.how === 'via') deps.push({ on: s.parent, how: `it is scoped through ${s.parent}` })
    for (const f of fks.filter(f => f.table === t && f.ref !== t && ['CASCADE', 'SET NULL', 'SET DEFAULT'].includes(f.onDelete))) deps.push({ on: f.ref, how: `${t}.${f.column} references ${f.ref} ON DELETE ${f.onDelete}` })
    for (const d of deps) {
      if (alwaysDeleted(d.on)) out.push(`${t} cannot be retained: ${d.how}, and ${d.on} is always deleted`)
      else if (!retain.has(d.on) && (scope.has(d.on))) out.push(`${t} cannot be retained without ${d.on}: ${d.how}, so deleting ${d.on} would remove or change its rows (retain ${d.on} too, or do not retain ${t})`)
    }
  }
  return [...new Set(out)]
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
// points). `requestedAt` is the time of the original request when a deletion is re-applied from the ledger (default:
// now). `lockTimeoutMs` (Postgres) bounds how long the request and each step wait for the tenant's in-flight writers before
// giving up with nothing changed (default 5 s). Returns the tombstone after the run.
export async function deleteTenant(d: DbLike, tenant: string, o: { policy?: DeletionPolicy; requestedBy?: string; now?: number; requestedAt?: number; until?: DeletionState; lockTimeoutMs?: number } = {}): Promise<Tombstone> {
  const db = asDb(d)
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const scope = new Map((await tenantScope(db)).map(s => [s.table, s]))
  const cols = await tableColumns(db)
  let t = await tombstone(db, tenant)
  const lockTimeoutMs = o.lockTimeoutMs ?? 5000
  if (t && o.policy) {
    // a second request must not silently resolve to the first one's policy: resume without a policy, or decide first
    const asked = JSON.stringify(validPolicy(o.policy, scope)), recorded = JSON.parse(t.policy) as DeletionPolicy
    if (asked !== JSON.stringify({ suppressions: recorded.suppressions, retainTables: [...(recorded.retainTables ?? [])].sort() }))
      throw new Error(`a deletion of this tenant is already recorded (state ${t.state}, requested by ${t.requested_by}) with a different policy: recorded ${t.policy}, asked ${asked}; resume it without a policy, or decide which one holds first`)
  }
  if (!t) {
    // the policy and retention checks read the schema only; the shared-workspace check reads data, so it runs in the
    // tombstone's own transaction below
    const policy = validPolicy(o.policy, scope)
    const keep = new Set([...(policy.retainTables ?? []), ...(policy.suppressions === 'retain' ? ['suppressions'] : []), ...Object.keys(ALWAYS_RETAINED)].filter(x => scope.has(x)))
    const unsatisfiable = retentionProblems(scope, await foreignKeys(db), keep)
    if (unsatisfiable.length) throw new Error(`retention policy cannot be honoured: ${unsatisfiable.join('; ')}`)
    if (!o.requestedBy) throw new Error('requestedBy is required (who asked, for the audit record)')
    const requestedBy = o.requestedBy.slice(0, 200), requestedAt = o.requestedAt ?? now
    try {
      await db.tx(function* (tx) {
        // the closing event takes the tenant's advisory lock (closingEventTx): bound that wait like a step's, or a
        // hung writer of this tenant would block a new request indefinitely. On timeout the whole request rolls
        // back: no tombstone, gate row or event survives.
        if (tx.kind === 'pg') yield* tx.get("SELECT set_config('lock_timeout', ?, true)", [`${lockTimeoutMs}ms`])
        yield* refuseSharedWorkspace(tx, cols, tenant)
        yield* tx.run("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES (?, ?, ?, 'requested', ?) ON CONFLICT (deleted_tenant) DO NOTHING",
          [tenant, requestedAt, requestedBy, JSON.stringify(policy)])
        yield* closingEventTx(tx, tenant, requestedBy, 'tenant.deletion_requested', requestedAt)
      })
    } catch (e) {
      if (/lock timeout/.test(e instanceof Error ? e.message : String(e))) throw new Error(`tenant deletion: the request waited ${lockTimeoutMs} ms for in-flight writes of this tenant and gave up; nothing changed, retry`, { cause: e })
      throw e
    }
    t = (await tombstone(db, tenant))!
  }
  const policy = JSON.parse(t.policy) as DeletionPolicy
  const retain = new Set([...(policy.retainTables ?? []), ...(policy.suppressions === 'retain' ? ['suppressions'] : []), ...Object.keys(ALWAYS_RETAINED)])
  const has = (x: string) => scope.has(x)
  // One step: its statements and the state change commit together, or not at all. On Postgres a write for this tenant
  // that passed the guard before the tombstone committed can still be open when a step runs (READ COMMITTED waits for
  // nothing), and would commit after the step deleted around it. Every guard trigger holds a shared advisory lock on
  // the row's tenant id for its transaction (lib/db/tenant-guard.ts), so each step first takes that key exclusively:
  // it waits for this tenant's open writers only (never for, or against, another tenant's), and its statements then
  // see their rows. The wait is bounded by lock_timeout for this transaction: on timeout the step rolls back, the
  // state is unchanged and the caller retries. SQLite has one writer at a time (BEGIN IMMEDIATE in sqliteDb): an open
  // writer makes the step wait or fail, never lose a row.
  const advance = async (from: DeletionState, to: DeletionState, body: (tx: Tx) => TxBody<void>) => {
    if (ORDER.indexOf(t!.state) >= ORDER.indexOf(to)) return true
    if (o.until && ORDER.indexOf(from) >= ORDER.indexOf(o.until)) return false
    try {
      await db.tx(function* (tx) {
        if (db.kind === 'pg') {
          yield* tx.get("SELECT set_config('lock_timeout', ?, true)", [`${lockTimeoutMs}ms`])
          yield* tx.get('SELECT pg_advisory_xact_lock(hashtext(?))', [tenant])
        }
        yield* body(tx)
        const r = yield* tx.run('UPDATE tenant_tombstones SET state = ? WHERE deleted_tenant = ? AND state = ?', [to, tenant, from])
        if (r.changes !== 1) throw new Error(`tenant deletion: expected state ${from}, another run moved it`)
      })
    } catch (e) {
      if (/lock timeout/.test(e instanceof Error ? e.message : String(e))) throw new Error(`tenant deletion: step ${from} -> ${to} waited ${lockTimeoutMs} ms for in-flight writes of this tenant and gave up; nothing changed, retry`, { cause: e })
      throw e
    }
    t = (await tombstone(db, tenant))!
    return true
  }
  function* del(tx: Tx, x: string): TxBody<void> { const w = owned(scope, x, tenant); yield* tx.run(`DELETE FROM "${x}" WHERE ${w.sql}`, w.params) }
  const parents = [...new Set([...scope.values()].flatMap(s => s.how === 'via' ? [s.parent] : []))].sort((a, b) => depth(scope, a) - depth(scope, b))
  const erase = [...scope.keys()].filter(x => !retain.has(x) && !UNGUARDED.has(x)).sort((a, b) => depth(scope, b) - depth(scope, a) || a.localeCompare(b))

  if (!await advance('requested', 'revoked', function* (tx) {
    // decision 9 with the rows as they are now, before anything is revoked (a membership that straddled the tombstone)
    yield* refuseSharedWorkspace(tx, cols, tenant)
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
    // decision 9 once more, right before the erase (a membership that arrived between the first step and this one on
    // a store without the member_id guard)
    yield* refuseSharedWorkspace(tx, cols, tenant)
    // unexpired evidence copies may only be deleted under this tenant's purge gate (lib/scan/evidence-copies.ts)
    const gate = has('evidence_purge_gate') && has('lead_evidence_copies')
    if (gate) yield* tx.run('INSERT INTO evidence_purge_gate (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING', [tenant])
    for (const x of erase) yield* del(tx, x)
    if (gate) yield* del(tx, 'evidence_purge_gate')
    // rate-limit counters are global, but a key can carry the tenant id as one of its ':'-separated parts (lib/rate-limit.ts):
    // those go too, matched as a whole part, so another tenant whose id extends this one keeps its counters
    if (cols.has('rate_limits')) yield* tx.run("DELETE FROM rate_limits WHERE (':' || key || ':') LIKE ? ESCAPE '\\'", [`%:${tenant.replace(/[\\%_]/g, m => `\\${m}`)}:%`])
    yield* tx.run('DELETE FROM users WHERE id = ?', [tenant])
    if (has('memberships')) yield* tx.run('DELETE FROM organizations WHERE id = ?', [tenant])
    yield* closingEventTx(tx, tenant, t!.requested_by, 'tenant.deletion_erased', now)
  })) return t
  await advance('erased', 'completed', function* (tx) {
    const kept: Record<string, number> = {}
    for (const x of [...retain].sort()) if (has(x)) { const w = owned(scope, x, tenant); kept[x] = Number((yield* tx.get<{ n: number }>(`SELECT count(*) AS n FROM "${x}" WHERE ${w.sql}`, w.params))?.n ?? 0) }
    // Retained consent proof is exactly tenant id + event type + timestamp (owner scope 2026-11-02, #564):
    // null the live operational detail on this tenant's onboarding_audit rows in THIS transaction. Completion
    // is never acknowledged while retained rows still carry detail - a redaction failure rolls the whole step
    // back (state stays 'erased', resumable), so no background tick's health is part of the guarantee. Same
    // gate the purge uses (lib/outreach/onboarding-policy.ts); the tick redaction is only a backstop for
    // tenants completed before this hook. Skipped where the schema predates the onboarding tables.
    if (cols.has('onboarding_audit') && cols.has('onboarding_audit_purge_gate')) {
      yield* tx.run('INSERT INTO onboarding_audit_purge_gate (id) VALUES (1)')
      yield* tx.run('UPDATE onboarding_audit SET detail = NULL WHERE tenant_id = ? AND detail IS NOT NULL', [tenant])
      yield* tx.run('DELETE FROM onboarding_audit_purge_gate WHERE id = 1')
    }
    // the completed marker is part of the retained trail it reports: write it, then count it in
    yield* closingEventTx(tx, tenant, t!.requested_by, 'tenant.deletion_completed', now, { retained_tables: Object.keys(kept).length })
    if (kept.audit_events !== undefined) kept.audit_events += 1
    yield* tx.run('UPDATE tenant_tombstones SET retained = ?, completed_at = ? WHERE deleted_tenant = ?', [JSON.stringify(kept), now, tenant])
  })
  return t
}

// After a restore: re-apply every ledgered deletion (lines from tombstoneLedgerEntry). A restored store has the rows
// back and may lack the tombstone; each deletion is re-recorded with its original policy and request time and run to
// completion. A line that is refused (a malformed line, or a tenant the restored store now shows as a shared workspace)
// does not stop the others: every line is attempted, then the refused ones are reported together as a
// TombstoneReapplyError, and the operator must not let the store serve until each is resolved.
export class TombstoneReapplyError extends Error {
  readonly failed: { tenant: string; reason: string }[]
  readonly applied: { tenant: string; state: DeletionState }[]
  constructor(failed: { tenant: string; reason: string }[], applied: { tenant: string; state: DeletionState }[]) {
    super(`${failed.length} ledgered deletion(s) not re-applied, the restored store must not serve traffic: ${failed.map(f => `${f.tenant}: ${f.reason}`).join('; ')}`)
    this.name = 'TombstoneReapplyError'
    this.failed = failed; this.applied = applied
  }
}
export async function reapplyTombstones(d: DbLike, ledgerLines: string[], now?: number): Promise<{ tenant: string; state: DeletionState }[]> {
  const applied: { tenant: string; state: DeletionState }[] = [], failed: { tenant: string; reason: string }[] = []
  const lines = ledgerLines.map(l => l.trim()).filter(Boolean)
  for (const [i, line] of lines.entries()) {
    let tenant = `ledger line ${i + 1}`
    try {
      const e = JSON.parse(line) as { kind: string; deleted_tenant: string; requested_at: number; requested_by: string; policy: DeletionPolicy }
      if (e.kind !== 'dazl-tenant-tombstone' || typeof e.deleted_tenant !== 'string') throw new Error('not a tenant tombstone ledger line')
      tenant = e.deleted_tenant
      const t = await deleteTenant(d, e.deleted_tenant, { policy: e.policy, requestedBy: `${e.requested_by} (re-applied after restore)`, requestedAt: Number(e.requested_at) || undefined, now })
      applied.push({ tenant: e.deleted_tenant, state: t.state })
    } catch (err) {
      failed.push({ tenant, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  if (failed.length) throw new TombstoneReapplyError(failed, applied)
  return applied
}

export type { Scope }
