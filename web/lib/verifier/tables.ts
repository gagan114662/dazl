// SQLite DDL for the independent evidence verifier's verdict records (lib/verifier/store.ts).
// PG: lib/db/migrations/pg/0048_evidence_verdicts.sql.
// One row per verification run, tenant-scoped. A row is written 'running' with the run's budget reserved before anything
// is fetched, then completed once with its verdict and full record; a completed row can never change (trigger). Rows are
// erased with their tenant (lib/tenant/lifecycle.ts); nothing else deletes them (no retention purge is defined).
import type Database from 'better-sqlite3'

export function migrateEvidenceVerdicts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_verdicts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      claim_hash TEXT NOT NULL CHECK (length(claim_hash) = 64),
      verifier_version TEXT NOT NULL CHECK (length(verifier_version) <= 40),
      state TEXT NOT NULL CHECK (state IN ('running', 'done')),
      verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'unknown')),
      action TEXT CHECK (action IS NULL OR action IN ('accept', 'hold', 'skip')),
      day TEXT NOT NULL CHECK (length(day) = 10),
      reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
      spent_micros INTEGER CHECK (spent_micros IS NULL OR spent_micros >= 0),
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      record TEXT CHECK (record IS NULL OR length(record) <= 2000000)
    );
    CREATE INDEX IF NOT EXISTS evidence_verdicts_tenant_day ON evidence_verdicts (tenant_id, day);
    CREATE INDEX IF NOT EXISTS evidence_verdicts_tenant_claim ON evidence_verdicts (tenant_id, claim_hash, created_at);
    CREATE TRIGGER IF NOT EXISTS evidence_verdicts_final BEFORE UPDATE ON evidence_verdicts
      WHEN OLD.state = 'done'
      BEGIN SELECT RAISE(ABORT, 'evidence verdicts are final once done'); END;
  `)
}
