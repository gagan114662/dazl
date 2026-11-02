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
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { conversionEventFor } from './lifecycle.ts'

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
  `)
}

const norm = (email: string): string => email.trim().toLowerCase().slice(0, 200)

function auditOnboarding(db: Database.Database, tenantId: string, action: string, detail: string | null, now: number): void {
  db.prepare('INSERT INTO onboarding_audit (id, tenant_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomBytes(12).toString('hex'), tenantId, action, detail, now)
}

export function activeOnboardingPolicy(db: Database.Database, tenantId: string): { policy_version: string; opted_in_by: string; opted_in_at: number } | null {
  migrateOnboardingPolicy(db)
  const r = db.prepare('SELECT policy_version, opted_in_by, opted_in_at FROM onboarding_policies WHERE tenant_id = ? AND withdrawn_at IS NULL').get(tenantId) as { policy_version: string; opted_in_by: string; opted_in_at: number } | undefined
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
    auditOnboarding(db, tenantId, 'opted_in', `policy ${ONBOARDING_POLICY_VERSION} by ${actorUserId}`.slice(0, 200), now)
  })()
}

export function withdrawOnboarding(db: Database.Database, tenantId: string, actorUserId: string, now = Math.floor(Date.now() / 1000)): boolean {
  migrateOnboardingPolicy(db)
  let changed = 0
  db.transaction(() => {
    changed = (db.prepare('UPDATE onboarding_policies SET withdrawn_at = ? WHERE tenant_id = ? AND withdrawn_at IS NULL').run(now, tenantId) as { changes: number }).changes
    if (changed) auditOnboarding(db, tenantId, 'withdrawn', `by ${actorUserId}`.slice(0, 200), now)
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
  const ins = db.prepare('INSERT INTO onboarding_enrollments (tenant_id, email, source, enrolled_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, email) DO NOTHING')
    .run(tenantId, email, `conversion:${conv.kind}`.slice(0, 60), now) as { changes: number }
  if (ins.changes === 1) auditOnboarding(db, tenantId, 'enrolled', email.slice(0, 200), now)
  return ins.changes === 1 ? 'enrolled' : 'already'
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
