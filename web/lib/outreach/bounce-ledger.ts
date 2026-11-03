// Idempotent bounce accounting (#415): the unit of account is the ORIGINAL SEND + RECIPIENT, never the Gmail
// message that carried the notice. Duplicate DSNs arrive with different Gmail ids (separate threads, retries,
// multiple MTAs) and must increment bounce accounting exactly once; the in-thread notice path shares the same
// ledger so a notice seen in both places still counts once. Only a first-time record suppresses: recordBounce
// (suppression, audit, pause thresholds) runs exactly once per send+recipient.
import type Database from 'better-sqlite3'
import { recordBounce } from './autopilot.ts'
import type { DsnVerdict } from './dsn.ts'

export function migrateBounceLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounce_records (
      tenant_id TEXT NOT NULL, outreach_message_id TEXT NOT NULL, recipient TEXT NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, source_gmail_id TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, outreach_message_id, recipient)
    );
  `)
}

export type BounceApplication = 'recorded' | 'duplicate' | 'held' | 'ignored'

// Applies a DSN verdict to the ledger. 'source' names the ingestion path ('thread' for in-thread notices today,
// 'dsn' for the separate-thread path once wired). Soft, held and ignored verdicts never write: a soft failure is
// not a bounce, and a held notice is evidence for a person, not an account.
export function applyBounceVerdict(db: Database.Database, tenantId: string, verdict: DsnVerdict, source: string, sourceGmailId: string | null, now = Math.floor(Date.now() / 1000), record: typeof recordBounce = recordBounce): BounceApplication {
  if (verdict.kind === 'hold') return 'held'
  if (verdict.kind !== 'permanent') return 'ignored'
  // Ledger row and the suppression it triggers are ONE transaction: a crash between the insert and
  // recordBounce must not leave a dedup row whose suppression never happened (a later replay would read
  // the row as a duplicate and never repair it). On any failure the whole write rolls back and a replay
  // of the same DSN records and suppresses as it should. 'record' is injectable for failure tests only.
  return db.transaction((): BounceApplication => {
    const r = db.prepare('INSERT OR IGNORE INTO bounce_records (tenant_id, outreach_message_id, recipient, status, source, source_gmail_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tenantId, verdict.outreachMessageId, verdict.recipient.toLowerCase(), '5xx', source, sourceGmailId, now)
    if (r.changes !== 1) return 'duplicate'
    record(db, tenantId, verdict.recipient, now)
    return 'recorded'
  }).immediate()
}

export const bounceCount = (db: Database.Database, tenantId: string): number =>
  (db.prepare('SELECT count(*) AS n FROM bounce_records WHERE tenant_id = ?').get(tenantId) as { n: number }).n
