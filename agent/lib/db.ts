import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const DB_DIR = join(process.env["HOME"] ?? "/tmp", "dazl-agent", "workspace");
const DB_PATH = process.env["DAZL_DB_PATH"] ?? join(DB_DIR, "dazl.sqlite");

mkdirSync(DB_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      geography   TEXT NOT NULL DEFAULT '',
      icp         TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id            TEXT PRIMARY KEY,
      business_id   TEXT NOT NULL REFERENCES businesses(id),
      prospect_name TEXT NOT NULL DEFAULT '',
      company       TEXT NOT NULL DEFAULT '',
      signal        TEXT NOT NULL,
      source_url    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'new',
      score         INTEGER NOT NULL DEFAULT 50,
      email         TEXT,
      phone         TEXT,
      found_at      TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach (
      id          TEXT PRIMARY KEY,
      lead_id     TEXT NOT NULL REFERENCES leads(id),
      channel     TEXT NOT NULL DEFAULT 'email',
      subject     TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      sent_at     TEXT,
      replied_at  TEXT,
      status      TEXT NOT NULL DEFAULT 'queued',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sequences (
      id           TEXT PRIMARY KEY,
      lead_id      TEXT NOT NULL REFERENCES leads(id),
      day          INTEGER NOT NULL,
      queued_at    TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at      TEXT,
      cancelled_at TEXT,
      status       TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id          TEXT PRIMARY KEY,
      business_id TEXT,
      lead_id     TEXT,
      action_type TEXT NOT NULL,
      source_url  TEXT,
      outcome     TEXT,
      logged_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export interface Lead {
  id: string;
  business_id: string;
  prospect_name: string;
  company: string;
  signal: string;
  source_url: string;
  status: string;
  score: number;
  email: string | null;
  phone: string | null;
  found_at: string;
}

export function insertLead(lead: Omit<Lead, "status" | "score">): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO leads
      (id, business_id, prospect_name, company, signal, source_url, email, phone, found_at)
    VALUES
      (@id, @business_id, @prospect_name, @company, @signal, @source_url, @email, @phone, @found_at)
  `).run(lead);
}

export function getPendingSequences(): Array<{ id: string; lead_id: string; day: number }> {
  return getDb()
    .prepare(`SELECT id, lead_id, day FROM sequences WHERE status = 'pending' AND sent_at IS NULL`)
    .all() as Array<{ id: string; lead_id: string; day: number }>;
}

export function logAction(entry: {
  id: string;
  business_id?: string;
  lead_id?: string;
  action_type: string;
  source_url?: string;
  outcome?: string;
}): void {
  getDb().prepare(`
    INSERT INTO action_log (id, business_id, lead_id, action_type, source_url, outcome)
    VALUES (@id, @business_id, @lead_id, @action_type, @source_url, @outcome)
  `).run(entry);
}
