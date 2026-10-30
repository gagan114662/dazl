// SQLite DDL for tenant lead feedback (lib/scan/feedback.ts, #385).
import type Database from 'better-sqlite3'

// The scan's raw handle reads the table (runner rejections, lookalike cohorts). PG: lib/db/migrations/pg/0018_lead_feedback.sql.
export function migrateFeedback(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_feedback (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'reject')),
      level TEXT NOT NULL CHECK (level IN ('account', 'person', 'event')),
      reason TEXT,
      company_key TEXT NOT NULL,
      domain TEXT,
      person_key TEXT,
      event_date TEXT,
      source_host TEXT,
      lead_id TEXT,
      job_id TEXT,
      note TEXT CHECK (note IS NULL OR length(note) <= 300),
      created_at INTEGER NOT NULL,
      reset_at INTEGER,
      reset_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS lead_feedback_tenant ON lead_feedback (tenant_id, reset_at);
  `)
}
