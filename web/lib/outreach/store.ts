import type Database from 'better-sqlite3'

export const norm = (email: string) => email.trim().toLowerCase()

export function migrateOutreach(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_accounts (
      tenant_id    TEXT PRIMARY KEY,
      email        TEXT NOT NULL,
      refresh_ct   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
      connected_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      verifier   TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outreach_settings (
      tenant_id      TEXT PRIMARY KEY,
      sender_name    TEXT NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 100),
      postal_address TEXT NOT NULL CHECK (length(postal_address) BETWEEN 10 AND 300)
    );
    CREATE TABLE IF NOT EXISTS suppressions (
      tenant_id  TEXT NOT NULL,
      email      TEXT NOT NULL,
      reason     TEXT NOT NULL CHECK (reason IN ('unsubscribe','manual','bounce')),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, email)
    );
    -- One message per lead. Lifecycle: draft -> approved -> sending -> sent.
    -- 'sending' that never finished becomes 'uncertain' (never auto-resent).
    CREATE TABLE IF NOT EXISTS outreach_messages (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      lead_id        TEXT NOT NULL,
      to_email       TEXT NOT NULL,
      subject        TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 150),
      body           TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 3000),
      status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','skipped','uncertain')),
      approved_hash  TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      claimed_at     INTEGER,
      sent_at        INTEGER,
      gmail_id       TEXT,
      error          TEXT CHECK (error IS NULL OR length(error) <= 200),
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE (tenant_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS outreach_tenant ON outreach_messages (tenant_id, status);
    -- A sent message can never go back to a sendable state.
    CREATE TRIGGER IF NOT EXISTS outreach_sent_is_final
    BEFORE UPDATE OF status ON outreach_messages
    WHEN OLD.status IN ('sent','skipped') AND NEW.status <> OLD.status
    BEGIN SELECT RAISE(ABORT, 'final outreach status'); END;
  `)
}
