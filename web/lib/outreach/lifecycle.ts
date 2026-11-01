// Prospect lifecycle conversion (#417): when a prospect signs up, activates or pays, any acquisition work
// already queued for them must stop before the next send, atomically and idempotently; future autopilot
// plays must not pick them up again. Matching is by EXACT normalized email only - an unrelated same-name
// signup matches nothing, and ambiguous identity is never guessed.
//
// Authority boundary: only a VERIFIED identity converts. A password signup queues a durable PENDING event
// (no cancels, no exclusion) that activates when the address is verified (verifyEmail, resetPassword, or a
// Google sign-in to the same address); a Google account is verified by construction and converts at
// creation; a payment converts the bound checkout account's email once verified, and stays pending until it
// is. An unverified typed email can never suppress another tenant's work.
//
// Scope and boundaries:
// - Cancels AUTOMATED pending work: scheduler-held first touches, approved/active cold sequences, open warm
//   follow-up threads. Manual drafts (never scheduler-held) are the tenant's own action and are left alone.
//   In-flight 'sending' rows are not retracted; everything still pending is.
// - Rows are STOPPED with a terminal conversion reason, never deleted: experiment attribution
//   (outreach_signal_context snapshots) and history are preserved.
// - This is not a suppression: no suppressions row is written, so transactional service mail to the now-
//   customer is unaffected. Marketing cold plays stop through the mechanisms here.
// - Re-recording the same event is a no-op (event key is the primary key) and the cancels are status-guarded,
//   so retries and restarts cannot resurrect a stopped step.
// - The table is global by design (NOT_DIRECT in test/helpers/tenant-tables.ts): conversion is account-level,
//   and stopping a converted address's queued work across tenants is the point. account_tenant is
//   attribution only, never a scope.
import type Database from 'better-sqlite3'
import { stopSequenceForThread } from './sequences.ts'
import { tableExists } from './send-budget.ts'

export type LifecycleKind = 'signup' | 'activation' | 'payment'

export function migrateLifecycle(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      event_key      TEXT PRIMARY KEY,
      kind           TEXT NOT NULL CHECK (kind IN ('signup','activation','payment')),
      email          TEXT NOT NULL,
      account_tenant TEXT,
      created_at     INTEGER NOT NULL,
      activated_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS lifecycle_events_email ON lifecycle_events (email);
  `)
  try { db.exec('ALTER TABLE lifecycle_events ADD COLUMN activated_at INTEGER') } catch { /* exists */ }
}

export const normalizeLifecycleEmail = (email: string): string => email.trim().toLowerCase().slice(0, 200)

// The exact-email exclusion used by the autopilot candidate prefilter: a lead whose own contact OR whose
// crawled published email matches an ACTIVATED conversion is never a cold-play candidate again. A pending
// (unverified) event excludes nothing.
export const LIFECYCLE_NOT_CONVERTED = `NOT EXISTS (SELECT 1 FROM lifecycle_events le WHERE le.activated_at IS NOT NULL AND le.email = lower(trim(l.contact)))
       AND NOT EXISTS (SELECT 1 FROM lifecycle_events le JOIN lead_enrichments e2 ON e2.lead_id = l.id AND e2.tenant_id = j.user_id AND e2.connector = 'sitecrawl' AND e2.kind = 'email' WHERE le.activated_at IS NOT NULL AND le.email = lower(trim(e2.value)))`

// Stops every automated pending acquisition step addressed to that exact email across tenants. Runs inside
// the caller's transaction. Returns the number of rows stopped.
function cancelPendingFor(db: Database.Database, email: string, kind: LifecycleKind, now: number): number {
  const reason = `converted_${kind}`
  let stopped = 0
  // Approved/active cold sequences: the audited stop path, per owning tenant.
  const seqs = db.prepare("SELECT tenant_id, lead_id FROM sequences WHERE status IN ('approved','active') AND lower(trim(to_email)) = ?").all(email) as { tenant_id: string; lead_id: string }[]
  for (const s of seqs) { stopSequenceForThread(db, s.tenant_id, s.lead_id, 'stopped', reason, now); stopped++ }
  // Open warm follow-up threads.
  stopped += (db.prepare('UPDATE followup_threads SET stopped = ? WHERE stopped IS NULL AND lower(trim(to_email)) = ?').run(reason.slice(0, 40), email) as { changes: number }).changes
  // Scheduler-held first touches (autopilot queue). Manual drafts carry no hold record and are untouched.
  stopped += (db.prepare("UPDATE outreach_messages SET status = 'skipped', error = ?, hold_reason = NULL, hold_until = NULL WHERE status IN ('draft','approved') AND hold_reason IS NOT NULL AND lower(trim(to_email)) = ?").run(reason, email) as { changes: number }).changes
  return stopped
}

// Records a VERIFIED conversion and, in the SAME transaction, activates it and stops the pending work.
// When the same event was queued pending (unverified at the time), this activates it. Returns the number of
// rows stopped (0 when the event was already active).
export function recordLifecycleEvent(db: Database.Database, kind: LifecycleKind, rawEmail: string, accountTenant: string | null, now = Math.floor(Date.now() / 1000)): number {
  migrateLifecycle(db)
  const email = normalizeLifecycleEmail(rawEmail)
  if (!email || !email.includes('@')) return 0
  const key = `${kind}|${email}`
  let stopped = 0
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, kind, email, accountTenant, now, now)
    const activated = ins.changes === 1 ? 1 : (db.prepare('UPDATE lifecycle_events SET activated_at = ? WHERE event_key = ? AND activated_at IS NULL').run(now, key) as { changes: number }).changes
    if (activated === 1) stopped = cancelPendingFor(db, email, kind, now)
  })()
  return stopped
}

// Queues a durable PENDING conversion for an identity that is not verified yet: no cancels, no autopilot
// exclusion. activateLifecycleFor (or a later verified recordLifecycleEvent) completes it. Returns whether
// the event was newly queued.
export function queuePendingLifecycle(db: Database.Database, kind: LifecycleKind, rawEmail: string, accountTenant: string | null, now = Math.floor(Date.now() / 1000)): boolean {
  migrateLifecycle(db)
  const email = normalizeLifecycleEmail(rawEmail)
  if (!email || !email.includes('@')) return false
  const ins = db.prepare('INSERT OR IGNORE INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES (?, ?, ?, ?, ?, NULL)').run(`${kind}|${email}`, kind, email, accountTenant, now)
  return ins.changes === 1
}

// Ownership of the address is now proven (verification link, reset link, Google sign-in): activate every
// pending conversion queued for it, stopping the queued work for each. Idempotent; returns rows stopped.
export function activateLifecycleFor(db: Database.Database, rawEmail: string, now = Math.floor(Date.now() / 1000)): number {
  migrateLifecycle(db)
  const email = normalizeLifecycleEmail(rawEmail)
  if (!email || !email.includes('@')) return 0
  let stopped = 0
  db.transaction(() => {
    const rows = db.prepare('SELECT event_key, kind FROM lifecycle_events WHERE email = ? AND activated_at IS NULL').all(email) as { event_key: string; kind: LifecycleKind }[]
    for (const r of rows) {
      const u = db.prepare('UPDATE lifecycle_events SET activated_at = ? WHERE event_key = ? AND activated_at IS NULL').run(now, r.event_key) as { changes: number }
      if (u.changes === 1) stopped += cancelPendingFor(db, email, r.kind, now)
    }
  })()
  return stopped
}

// Fail-closed conversion check at the automated SEND boundaries (#417): an address blocks a send when it has
// an ACTIVATED conversion, or a PENDING one whose ownership is already proven. The activation drains are
// best-effort by design; a lost drain must never allow mail, so the boundary re-checks ownership itself
// (users is co-located in the app's store). A store without users (pure-outreach unit fixtures) has no
// accounts at all, so a pending row can prove nothing there and does not block.
export function conversionBlockedNow(db: Database.Database, rawEmail: string): boolean {
  migrateLifecycle(db)
  const email = normalizeLifecycleEmail(rawEmail)
  if (!email || !email.includes('@')) return false
  const rows = db.prepare('SELECT activated_at FROM lifecycle_events WHERE email = ?').all(email) as { activated_at: number | null }[]
  if (rows.some(r => r.activated_at !== null)) return true
  if (!rows.length) return false
  if (!tableExists(db, 'users')) return false
  return !!db.prepare('SELECT 1 AS x FROM users WHERE lower(trim(email)) = ? AND email_verified_at IS NOT NULL').get(email)
}

// Progress half of the fail-closed pair: activate every pending conversion whose address is now verified,
// stopping its queued work. Called at the start of each automated send pass so a drain lost at the
// verification boundary completes before that pass's sends. No-op in stores without accounts.
export function drainVerifiedPendingLifecycle(db: Database.Database, now = Math.floor(Date.now() / 1000)): number {
  migrateLifecycle(db)
  if (!tableExists(db, 'users')) return 0
  let stopped = 0
  db.transaction(() => {
    const rows = db.prepare('SELECT le.event_key, le.kind, le.email FROM lifecycle_events le WHERE le.activated_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE lower(trim(u.email)) = le.email AND u.email_verified_at IS NOT NULL)').all() as { event_key: string; kind: LifecycleKind; email: string }[]
    for (const r of rows) {
      const u = db.prepare('UPDATE lifecycle_events SET activated_at = ? WHERE event_key = ? AND activated_at IS NULL').run(now, r.event_key) as { changes: number }
      if (u.changes === 1) stopped += cancelPendingFor(db, r.email, r.kind, now)
    }
  })()
  return stopped
}

// The account a paid checkout binds to (#417): the tenant from client_reference_id/metadata. A personal
// workspace id IS its founder's users.id; otherwise exactly one owner resolves it. Zero or several owners is
// ambiguous and stays unmatched, never guessed. The Stripe-typed customer email is never used: the buyer can
// edit it at checkout, so it proves no ownership.
export function paymentAccountFor(db: Database.Database, tenantId: string): { email: string; verified: boolean } | null {
  const direct = db.prepare('SELECT email, email_verified_at AS v FROM users WHERE id = ?').get(tenantId) as { email: string; v: number | null } | undefined
  if (direct) return { email: direct.email, verified: direct.v !== null }
  const owners = db.prepare("SELECT u.email, u.email_verified_at AS v FROM memberships m JOIN users u ON u.id = m.member_id WHERE m.tenant_id = ? AND m.role = 'owner'").all(tenantId) as { email: string; v: number | null }[]
  if (owners.length !== 1) return null
  return { email: owners[0].email, verified: owners[0].v !== null }
}

// Read side for surfaces that need the terminal conversion reason (and for tests). Activated events only.
export function conversionEventFor(db: Database.Database, rawEmail: string): { kind: LifecycleKind; created_at: number } | null {
  migrateLifecycle(db)
  const r = db.prepare('SELECT kind, created_at FROM lifecycle_events WHERE email = ? AND activated_at IS NOT NULL ORDER BY created_at LIMIT 1').get(normalizeLifecycleEmail(rawEmail)) as { kind: LifecycleKind; created_at: number } | undefined
  return r ?? null
}
