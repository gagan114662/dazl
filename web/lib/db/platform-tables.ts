// SQLite DDL for platform tables that hold state shared by every app instance (docs/PLATFORM.md step 3).
// The PG side is lib/db/migrations/pg/0002_shared_state.sql.
import type Database from 'better-sqlite3'

export function migratePlatform(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY CHECK (length(key) <= 300),
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_limits_reset ON rate_limits (reset_at);
    CREATE TABLE IF NOT EXISTS app_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)
}
