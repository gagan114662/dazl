// The app's SQLite store: opens the file and runs the auth schema's SQLite half. This is engine code, like
// lib/db/insertion-order.ts (ENGINE_FILES in lib/db/sql-audit.ts): the Db layer's SQLite engine (lib/db/client.ts getDb)
// wraps this connection, and code still on the raw handle (getScanDb, lib/scan/service.ts) shares it.
// migrateAuth's statements are schema setup plus the one-time backfills whose Postgres half is a migration file:
//   sessions.public_id -> pg 0021_session_inventory.sql, sessions.authed_at -> pg 0022_session_fresh_auth.sql,
//   BACKFILL_SQL (lib/workspaces.ts) -> pg 0015_workspaces.sql (test/workspaces.test.ts holds them to the same SQL).
// test/pg-sql-audit.test.ts pins this file's raw statements to exactly those, so no business SQL can land here.
// Moved unchanged from lib/auth-db.ts (#354), which re-exports migrateAuth.
import Database from 'better-sqlite3'
import path from 'path'
import { BACKFILL_SQL, WORKSPACE_DDL } from '../workspaces.ts'
import { AUDIT_DDL } from '../audit.ts'
import { INVITATIONS_DDL } from '../workspace-members.ts'
import { EMAIL_TOKENS_DDL } from '../email-ownership.ts'
import { OUTBOX_DDL } from '../system-mail.ts'
import { SESSION_COLUMNS, SESSION_INDEXES, newPublicId } from '../sessions.ts'

let db: Database.Database | null = null

export function getAuthDb(): Database.Database {
  if (db) return db
  db = new Database(process.env.DB_PATH || path.join(process.cwd(), '..', '..', 'dazl-data', 'app.db'))
  db.pragma('journal_mode = WAL')
  migrateAuth(db)
  return db
}

export function migrateAuth(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      business_name TEXT,
      sells TEXT,
      website TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `)
  try { d.exec('ALTER TABLE users ADD COLUMN sells TEXT') } catch { /* exists */ }
  try { d.exec('ALTER TABLE users ADD COLUMN website TEXT') } catch { /* exists */ }
  try { d.exec('ALTER TABLE users ADD COLUMN buyer_profile TEXT') } catch { /* exists */ }
  // The workspace this session acts in (lib/workspaces.ts); NULL: the default one. PG: 0015_workspaces.sql.
  try { d.exec('ALTER TABLE sessions ADD COLUMN active_tenant_id TEXT') } catch { /* exists */ }
  // Session inventory and revocation (lib/sessions.ts). PG: 0021_session_inventory.sql.
  for (const c of SESSION_COLUMNS) { try { d.exec(c) } catch { /* exists */ } }
  const unnamed = d.prepare('SELECT id FROM sessions WHERE public_id IS NULL').all() as { id: string }[]
  const name = d.prepare('UPDATE sessions SET public_id = ? WHERE id = ?')
  d.transaction(() => { for (const r of unnamed) name.run(newPublicId(), r.id) })()
  d.exec('UPDATE sessions SET authed_at = coalesce(created_at, 0) WHERE authed_at IS NULL')
  d.exec(SESSION_INDEXES)
  // Email ownership and recovery (lib/email-ownership.ts); Google accounts are backfilled in migrateOauth.
  try { d.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER') } catch { /* exists */ }
  d.exec(EMAIL_TOKENS_DDL)
  d.exec(OUTBOX_DDL)
  // Durable audit trail (lib/audit.ts). PG: 0041_audit_events.sql.
  d.exec(AUDIT_DDL)
  d.exec(WORKSPACE_DDL)
  d.exec(INVITATIONS_DDL)

  d.transaction(() => { for (const s of BACKFILL_SQL) d.prepare(s).run() })()
}
