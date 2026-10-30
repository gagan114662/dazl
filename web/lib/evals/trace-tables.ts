// SQLite DDL for captured production scan traces (lib/evals/capture.ts). PG: lib/db/migrations/pg/0018_scan_traces.sql.
// One row per captured run attempt: the trace JSON is redacted before it is written, and rows are deleted once older than
// the configured retention (DAZL_TRACE_RETENTION_DAYS).
import type Database from 'better-sqlite3'

export function migrateTraceStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_traces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      trace TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scan_traces_tenant ON scan_traces (tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS scan_traces_created ON scan_traces (created_at);
  `)
}
