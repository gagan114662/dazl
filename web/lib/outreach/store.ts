import type Database from 'better-sqlite3'
import { migrateInsertionOrder } from '../db/insertion-order.ts'
import { migrateAttribution } from './attribution.ts'

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
    CREATE TABLE IF NOT EXISTS outreach_llm_usage (
      id            INTEGER PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      message_id    TEXT,
      purpose       TEXT NOT NULL,
      vendor        TEXT,
      requested_model TEXT,
      model         TEXT,
      request_id    TEXT,
      outcome       TEXT NOT NULL,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
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
      hold_reason    TEXT,
      hold_until     INTEGER,
      hold_policy    TEXT,
      offer_hash     TEXT,
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
  const addCol = (t: string, c: string, def: string) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`) } catch { /* exists */ } }
  addCol('oauth_states', 'read_scope', 'INTEGER NOT NULL DEFAULT 0')
  addCol('gmail_accounts', 'read_granted', 'INTEGER NOT NULL DEFAULT 0')
  addCol('outreach_messages', 'thread_id', 'TEXT')
  addCol('outreach_messages', 'test', 'INTEGER NOT NULL DEFAULT 0') // 1 = addressed to a tenant-allowlisted test inbox
  addCol('outreach_messages', 'hold_reason', 'TEXT') // why a first-touch draft is held; NULL = never held by the scheduler (legacy/manual)
  addCol('outreach_messages', 'hold_until', 'INTEGER') // earliest retry time (unix seconds); NULL = no scheduler retry
  addCol('outreach_messages', 'hold_policy', 'TEXT') // consent version the hold was recorded under; drain never acts on another version
  addCol('outreach_messages', 'offer_hash', 'TEXT') // hash of the offer inputs the draft's words were created under
  addCol('outreach_settings', 'booking_url', 'TEXT')
  // Idempotent upgrades for usage tables created before these columns existed.
  // Column presence is checked against the live schema; a genuinely failing
  // ALTER throws here at startup instead of being hidden by a broad catch.
  {
    const have = new Set((db.prepare('PRAGMA table_info(outreach_llm_usage)').all() as { name: string }[]).map(c => c.name))
    if (!have.has('requested_model')) db.exec('ALTER TABLE outreach_llm_usage ADD COLUMN requested_model TEXT')
    if (!have.has('cache_read_input_tokens')) db.exec('ALTER TABLE outreach_llm_usage ADD COLUMN cache_read_input_tokens INTEGER')
    if (!have.has('cache_creation_input_tokens')) db.exec('ALTER TABLE outreach_llm_usage ADD COLUMN cache_creation_input_tokens INTEGER')
  }
  migrateAttribution(db)
  migrateInsertionOrder(db, ['outreach_messages']) // insert_seq (lib/db/insertion-order.ts)
}
