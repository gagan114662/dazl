// Prospect lifecycle conversion (#417): when a prospect signs up, activates or pays, any acquisition work
// already queued for them must stop before the next send, atomically and idempotently; future autopilot
// plays must not pick them up again. Matching is by EXACT normalized email only - an unrelated same-name
// signup matches nothing, and ambiguous identity is never guessed.
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
import type Database from 'better-sqlite3'
import { stopSequenceForThread } from './sequences.ts'

export type LifecycleKind = 'signup' | 'activation' | 'payment'

export function migrateLifecycle(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      event_key      TEXT PRIMARY KEY,
      kind           TEXT NOT NULL CHECK (kind IN ('signup','activation','payment')),
      email          TEXT NOT NULL,
      account_tenant TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lifecycle_events_email ON lifecycle_events (email);
  `)
}

export const normalizeLifecycleEmail = (email: string): string => email.trim().toLowerCase().slice(0, 200)

// The exact-email exclusion used by the autopilot candidate prefilter: a lead whose own contact OR whose
// crawled published email matches a converted prospect is never a cold-play candidate again.
export const LIFECYCLE_NOT_CONVERTED = `NOT EXISTS (SELECT 1 FROM lifecycle_events le WHERE le.email = lower(trim(l.contact)))
       AND NOT EXISTS (SELECT 1 FROM lifecycle_events le JOIN lead_enrichments e2 ON e2.lead_id = l.id AND e2.tenant_id = j.user_id AND e2.connector = 'sitecrawl' AND e2.kind = 'email' AND le.email = lower(trim(e2.value)))`

// Records the event and, in the SAME transaction, stops every automated pending acquisition step addressed
// to that exact email across tenants. Returns the number of rows stopped (0 when the event was already known).
export function recordLifecycleEvent(db: Database.Database, kind: LifecycleKind, rawEmail: string, accountTenant: string | null, now = Math.floor(Date.now() / 1000)): number {
  migrateLifecycle(db)
  const email = normalizeLifecycleEmail(rawEmail)
  if (!email || !email.includes('@')) return 0
  const reason = `converted_${kind}`
  let stopped = 0
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO lifecycle_events (event_key, kind, email, account_tenant, created_at) VALUES (?, ?, ?, ?, ?)').run(`${kind}|${email}`, kind, email, accountTenant, now)
    // Approved/active cold sequences: the audited stop path, per owning tenant.
    const seqs = db.prepare("SELECT tenant_id, lead_id FROM sequences WHERE status IN ('approved','active') AND lower(trim(to_email)) = ?").all(email) as { tenant_id: string; lead_id: string }[]
    for (const s of seqs) { stopSequenceForThread(db, s.tenant_id, s.lead_id, 'stopped', reason, now); stopped++ }
    // Open warm follow-up threads.
    stopped += (db.prepare('UPDATE followup_threads SET stopped = ? WHERE stopped IS NULL AND lower(trim(to_email)) = ?').run(reason.slice(0, 40), email) as { changes: number }).changes
    // Scheduler-held first touches (autopilot queue). Manual drafts carry no hold record and are untouched.
    stopped += (db.prepare("UPDATE outreach_messages SET status = 'skipped', error = ?, hold_reason = NULL, hold_until = NULL WHERE status IN ('draft','approved') AND hold_reason IS NOT NULL AND lower(trim(to_email)) = ?").run(reason, email) as { changes: number }).changes
    void ins
  })()
  return stopped
}

// Read side for surfaces that need the terminal conversion reason (and for tests).
export function conversionEventFor(db: Database.Database, rawEmail: string): { kind: LifecycleKind; created_at: number } | null {
  migrateLifecycle(db)
  const r = db.prepare('SELECT kind, created_at FROM lifecycle_events WHERE email = ? ORDER BY created_at LIMIT 1').get(normalizeLifecycleEmail(rawEmail)) as { kind: LifecycleKind; created_at: number } | undefined
  return r ?? null
}
