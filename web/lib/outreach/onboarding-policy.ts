// Onboarding / customer-success policy (#417 remaining half). When a prospect converts, acquisition work
// stops (lifecycle.ts). Anything AFTER that - onboarding nudges, customer-success mail - is not the cold
// campaign and must run under its OWN explicitly opted-in policy. Opt-in is never inferred: not from the
// cold launch policy, not from a verified signup, not from a payment. Only an authorized surface recording
// an explicit opt-in action creates a policy, and first activation on a real tenant is an owner authority
// decision reviewed outside this code.
//
// Fail closed everywhere:
// - no active policy -> enrollment refused, sends refused
// - enrollment requires an ACTIVATED conversion (only customers onboard; a pending/unverified one is not)
// - withdrawal ends both enrollment and the send gate immediately
// - ambiguous identity stays unmatched: enrollment keys the exact normalized email, same rules as lifecycle.ts
//
// Marketing suppression stays separate: this module never writes suppressions, so transactional service
// mail to a customer is unaffected by anything here.
//
// Two decisions, made now rather than at first activation:
// - onboarding_audit is APPEND-ONLY consent evidence (update refused, delete refused outside the retention
//   purge's own gated transaction, both engines) and content-free at the source: it records action/actor/time and
//   non-PII detail (never an email). The RETAINED record after erasure is exactly tenant_id + action + created_at
//   (owner scope 2026-11-02, DECISIONS.md): redactOnboardingAuditDetails nulls live operational detail
//   (policy version, conversion kind) once the tenant's erasure completes. Retention period is the owner
//   decision of 2026-11-02 (docs/DECISIONS.md, #564):
//   rows survive tenant erasure (lib/tenant/lifecycle.ts ALWAYS_RETAINED) and are purged 2 calendar years
//   after the erasure completed - the rows are the only proof consent was obtained, and disputes can surface after
//   an account is gone. The period is PROVISIONAL pending #535's compliance review. The erasable enrollments
//   table carries the email; audit rows correlate by tenant and time.
// - policy versions RECONSENT, never grandfather: the gate and enrollment accept only the CURRENT
//   ONBOARDING_POLICY_VERSION. A future policy/copy change bumps the version and every earlier opt-in stops
//   counting until the actor opts in again - silent continuation under changed terms is not consent.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { conversionEventFor } from './lifecycle.ts'
import { tableExists } from './send-budget.ts'

export const ONBOARDING_POLICY_VERSION = '2026-11-02'

export function migrateOnboardingPolicy(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_policies (
      tenant_id      TEXT PRIMARY KEY,
      policy_version TEXT NOT NULL,
      opted_in_by    TEXT NOT NULL,
      opted_in_at    INTEGER NOT NULL,
      withdrawn_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS onboarding_enrollments (
      tenant_id   TEXT NOT NULL,
      email       TEXT NOT NULL,
      source      TEXT NOT NULL,
      enrolled_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, email)
    );
    CREATE TABLE IF NOT EXISTS onboarding_audit (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS onboarding_audit_tenant ON onboarding_audit (tenant_id, created_at);
    CREATE TABLE IF NOT EXISTS onboarding_audit_purge_gate (id INTEGER PRIMARY KEY CHECK (id = 1));
    DROP TRIGGER IF EXISTS onboarding_audit_no_update;
    CREATE TRIGGER onboarding_audit_no_update BEFORE UPDATE ON onboarding_audit
      WHEN NOT EXISTS (SELECT 1 FROM onboarding_audit_purge_gate)
      BEGIN SELECT RAISE(ABORT, 'onboarding audit is append-only'); END;
    DROP TRIGGER IF EXISTS onboarding_audit_no_delete;
    CREATE TRIGGER onboarding_audit_no_delete BEFORE DELETE ON onboarding_audit
      WHEN NOT EXISTS (SELECT 1 FROM onboarding_audit_purge_gate)
      BEGIN SELECT RAISE(ABORT, 'onboarding audit is append-only'); END;
  `)
}

const norm = (email: string): string => email.trim().toLowerCase().slice(0, 200)

function auditOnboarding(db: Database.Database, tenantId: string, action: string, detail: string | null, now: number): void {
  db.prepare('INSERT INTO onboarding_audit (id, tenant_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomBytes(12).toString('hex'), tenantId, action, detail, now)
}

// Owner decision 2026-11-02 (docs/DECISIONS.md, #564): content-free consent proof (action + time, never an email)
// is retained 2 YEARS after the tenant's erasure completed, then purged. PROVISIONAL pending #535's compliance
// review. Two years is a CALENDAR anniversary, never a fixed-second interval: 730 days can fall short of two
// years across a leap day, and purging early is destroying consent proof before the promised period.
export const ONBOARDING_AUDIT_RETAIN_YEARS = 2

// The purge cutoff for `now`: the same instant two calendar years earlier. A Feb 29 reference rolls to Mar 1
// (never Feb 28), so the boundary can only retain longer, never purge early.
export function onboardingAuditCutoff(nowS: number): number {
  const d = new Date(nowS * 1000)
  d.setUTCFullYear(d.getUTCFullYear() - ONBOARDING_AUDIT_RETAIN_YEARS)
  return Math.floor(d.getTime() / 1000)
}

// The purge path for that decision: only rows whose tenant's deletion COMPLETED more than 2 calendar years
// ago (tenant_tombstones.completed_at anchors "after account deletion"); rows of any live or still-deleting tenant
// never match. At most `limit` per call (1000 default, never over 10000), inside the only transaction the delete
// trigger allows (its gate row exists only here), fenced by the tick's lease like every purge in lib/audit.ts.
export async function purgeOnboardingAudit(db: Db, o: { now?: number; limit?: number; fence?: (t: Tx) => TxBody<void> }): Promise<number> {
  const cutoff = onboardingAuditCutoff(o.now ?? Math.floor(Date.now() / 1000))
  const limit = Math.max(1, Math.min(o.limit ?? 1000, 10000))
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    yield* t.run('INSERT INTO onboarding_audit_purge_gate (id) VALUES (1)')
    const r = yield* t.run(
      `DELETE FROM onboarding_audit WHERE id IN (
         SELECT o.id FROM onboarding_audit o
         JOIN tenant_tombstones tt ON tt.deleted_tenant = o.tenant_id
         WHERE tt.completed_at IS NOT NULL AND tt.completed_at < ?
         ORDER BY o.created_at LIMIT ?)`,
      [cutoff, limit])
    yield* t.run('DELETE FROM onboarding_audit_purge_gate WHERE id = 1')
    return r.changes
  })
}

// The other half of the retained-record scope: live rows may carry operational detail, but the proof kept
// after erasure is exactly tenant_id + action + created_at. The deletion-completion step in lifecycle.ts
// redacts atomically with the completed tombstone; THIS tick call is the backstop for tenants whose erasure
// completed before that hook shipped. Same gated transaction as the purge (the update trigger's only
// allowance), bounded, fenced by the tick lease, idempotent. Live and still-deleting tenants keep their
// operational detail.
export async function redactOnboardingAuditDetails(db: Db, o: { limit?: number; fence?: (t: Tx) => TxBody<void> } = {}): Promise<number> {
  const limit = Math.max(1, Math.min(o.limit ?? 1000, 10000))
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    yield* t.run('INSERT INTO onboarding_audit_purge_gate (id) VALUES (1)')
    const r = yield* t.run(
      `UPDATE onboarding_audit SET detail = NULL WHERE id IN (
         SELECT o.id FROM onboarding_audit o
         JOIN tenant_tombstones tt ON tt.deleted_tenant = o.tenant_id
         WHERE tt.completed_at IS NOT NULL AND o.detail IS NOT NULL
         ORDER BY o.created_at LIMIT ?)`,
      [limit])
    yield* t.run('DELETE FROM onboarding_audit_purge_gate WHERE id = 1')
    return r.changes
  })
}

export function activeOnboardingPolicy(db: Database.Database, tenantId: string): { policy_version: string; opted_in_by: string; opted_in_at: number } | null {
  migrateOnboardingPolicy(db)
  // Current version only: an opt-in under older terms is recorded but no longer active (reconsent, never grandfather).
  const r = db.prepare('SELECT policy_version, opted_in_by, opted_in_at FROM onboarding_policies WHERE tenant_id = ? AND withdrawn_at IS NULL AND policy_version = ?').get(tenantId, ONBOARDING_POLICY_VERSION) as { policy_version: string; opted_in_by: string; opted_in_at: number } | undefined
  return r ?? null
}

// Records an explicit opt-in. actorUserId is the authenticated account that took the action; the route
// layer proves that. Re-opt-in after withdrawal starts a fresh policy row (withdrawn_at cleared), audited.
export function optInOnboarding(db: Database.Database, tenantId: string, actorUserId: string, now = Math.floor(Date.now() / 1000)): void {
  migrateOnboardingPolicy(db)
  db.transaction(() => {
    db.prepare(`INSERT INTO onboarding_policies (tenant_id, policy_version, opted_in_by, opted_in_at, withdrawn_at) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT (tenant_id) DO UPDATE SET policy_version = excluded.policy_version, opted_in_by = excluded.opted_in_by, opted_in_at = excluded.opted_in_at, withdrawn_at = NULL`)
      .run(tenantId, ONBOARDING_POLICY_VERSION, actorUserId, now)
    auditOnboarding(db, tenantId, 'opted_in', `policy ${ONBOARDING_POLICY_VERSION}`, now)
  })()
}

export function withdrawOnboarding(db: Database.Database, tenantId: string, _actorUserId: string, now = Math.floor(Date.now() / 1000)): boolean {
  migrateOnboardingPolicy(db)
  let changed = 0
  db.transaction(() => {
    changed = (db.prepare('UPDATE onboarding_policies SET withdrawn_at = ? WHERE tenant_id = ? AND withdrawn_at IS NULL').run(now, tenantId) as { changes: number }).changes
    if (changed) auditOnboarding(db, tenantId, 'withdrawn', null, now)
  })()
  return changed === 1
}

export type EnrollOutcome = 'enrolled' | 'already' | 'no_policy' | 'not_customer'

// Enrolls a converted address. Refuses without an active policy and without an ACTIVATED conversion -
// onboarding a non-customer or an unverified identity is never allowed. Idempotent on (tenant, email).
export function enrollOnboarding(db: Database.Database, tenantId: string, rawEmail: string, now = Math.floor(Date.now() / 1000)): EnrollOutcome {
  migrateOnboardingPolicy(db)
  const email = norm(rawEmail)
  if (!email || !email.includes('@')) return 'not_customer'
  if (!activeOnboardingPolicy(db, tenantId)) return 'no_policy'
  const conv = conversionEventFor(db, email)
  if (!conv) return 'not_customer'
  return insertEnrollment(db, tenantId, email, conv.kind, now)
}

function insertEnrollment(db: Database.Database, tenantId: string, email: string, kind: string, now: number): 'enrolled' | 'already' {
  const ins = db.prepare('INSERT INTO onboarding_enrollments (tenant_id, email, source, enrolled_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, email) DO NOTHING')
    .run(tenantId, email, `conversion:${kind}`.slice(0, 60), now) as { changes: number }
  if (ins.changes === 1) auditOnboarding(db, tenantId, 'enrolled', `conversion:${kind}`, now) // never the email: audit is content-free consent evidence
  return ins.changes === 1 ? 'enrolled' : 'already'
}

const ACTIVE_POLICY_SQL = 'SELECT 1 AS x FROM onboarding_policies WHERE tenant_id = ? AND withdrawn_at IS NULL AND policy_version = ?'

// The conversion transition (#417), called by lifecycle.ts INSIDE the transaction that activates a conversion
// and stops the address's queued acquisition work, once per tenant whose work it stopped (`email` is already
// normalized and the conversion is activated by then). Enrolls only under that tenant's active, current-version
// policy; otherwise it is a no-op ('no_policy'). No migration/DDL: it runs inside the caller's (possibly
// lease-fenced) transaction, and a store without the policy tables holds no policy, so it enrolls nothing.
export function transitionToOnboarding(db: Database.Database, tenantId: string, email: string, kind: string, now: number): EnrollOutcome {
  if (!tableExists(db, 'onboarding_policies')) return 'no_policy'
  if (!db.prepare(ACTIVE_POLICY_SQL).get(tenantId, ONBOARDING_POLICY_VERSION)) return 'no_policy'
  return insertEnrollment(db, tenantId, email, kind, now)
}

// The same transition on the Db layer (the billing webhook's payment conversion), statement for statement.
export function* transitionToOnboardingTx(t: Tx, tenantId: string, email: string, kind: string, now: number): TxBody<EnrollOutcome> {
  if (!(yield* t.get(ACTIVE_POLICY_SQL, [tenantId, ONBOARDING_POLICY_VERSION]))) return 'no_policy'
  const ins = yield* t.run('INSERT INTO onboarding_enrollments (tenant_id, email, source, enrolled_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, email) DO NOTHING', [tenantId, email, `conversion:${kind}`.slice(0, 60), now])
  if (ins.changes !== 1) return 'already'
  yield* t.run('INSERT INTO onboarding_audit (id, tenant_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)', [randomBytes(12).toString('hex'), tenantId, 'enrolled', `conversion:${kind}`, now])
  return 'enrolled'
}

// The gate every onboarding/customer-success sender must pass BEFORE building or sending anything:
// active policy AND activated conversion AND enrolled. Anything unknown refuses.
export function onboardingSendAllowed(db: Database.Database, tenantId: string, rawEmail: string): boolean {
  migrateOnboardingPolicy(db)
  const email = norm(rawEmail)
  if (!email || !email.includes('@')) return false
  if (!activeOnboardingPolicy(db, tenantId)) return false
  if (!conversionEventFor(db, email)) return false
  return !!db.prepare('SELECT 1 FROM onboarding_enrollments WHERE tenant_id = ? AND email = ?').get(tenantId, email)
}
