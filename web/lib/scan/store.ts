import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'

export const STALE_RUNNING_S = Number(process.env.SCAN_STALE_RUNNING_S || 20 * 60)
export const MAX_ATTEMPTS = 3

export interface ScanInput {
  business_name: string
  industry: string
  location: string
}
// Free-text request. The legacy columns stay filled (placeholders) so older workers keep working.
export interface QueryInput { query: string; icp?: string | null; sources?: string | null }

// Schema notes for the external worker (Hermes). Everything is enforced in
// SQLite itself, so a writer that bypasses the web app cannot corrupt state:
//  - status values and legal transitions are enforced by CHECK + trigger
//  - lengths are capped by CHECK
//  - a lead needs a signal (reason) and an http(s) source_url
export function migrateScan(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_jobs (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 150),
      industry      TEXT NOT NULL CHECK (length(industry) BETWEEN 1 AND 100),
      location      TEXT NOT NULL CHECK (length(location) BETWEEN 1 AND 100),
      attempts      INTEGER NOT NULL DEFAULT 0,
      error         TEXT CHECK (error IS NULL OR length(error) <= 200),
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      claimed_at    INTEGER,
      finished_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS scan_jobs_user ON scan_jobs (user_id, created_at);
    CREATE INDEX IF NOT EXISTS scan_jobs_status ON scan_jobs (status, created_at);

    CREATE TABLE IF NOT EXISTS leads (
      id          TEXT PRIMARY KEY,
      scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      name        TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 150),
      company     TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 150),
      contact     TEXT CHECK (contact IS NULL OR length(contact) <= 254),
      signal      TEXT NOT NULL CHECK (length(signal) BETWEEN 1 AND 500),
      source_url  TEXT NOT NULL CHECK (length(source_url) <= 500 AND (source_url LIKE 'https://%' OR source_url LIKE 'http://%')),
      score       INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
      created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      CHECK (name <> '' OR company <> '')
    );
    CREATE INDEX IF NOT EXISTS leads_job ON leads (scan_job_id);

    -- Legal transitions only: pending->running, running->done|failed,
    -- running->pending (stale-job retry). Finished jobs are immutable.
    CREATE TRIGGER IF NOT EXISTS scan_jobs_transitions
    BEFORE UPDATE OF status ON scan_jobs
    WHEN NOT (
      (OLD.status = 'pending' AND NEW.status = 'running') OR
      (OLD.status = 'running' AND NEW.status IN ('done','failed','pending')) OR
      OLD.status = NEW.status
    )
    BEGIN SELECT RAISE(ABORT, 'illegal scan job status transition'); END;

    -- Leads can only be added to a job that is currently running.
    CREATE TRIGGER IF NOT EXISTS leads_only_while_running
    BEFORE INSERT ON leads
    WHEN (SELECT status FROM scan_jobs WHERE id = NEW.scan_job_id) IS NOT 'running'
    BEGIN SELECT RAISE(ABORT, 'leads can only be added to a running job'); END;
  `)
  addColumns(db)
}

// Evidence columns. Nullable, so rows written by other workers (Hermes) stay valid:
// a lead with no evidence_excerpt was not verified by dazl.
function addColumns(db: Database.Database): void {
  const has = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some(r => r.name === c)
  const add = (t: string, c: string, def: string) => { if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`) }
  add('leads', 'evidence_excerpt', 'TEXT CHECK (evidence_excerpt IS NULL OR length(evidence_excerpt) <= 400)')
  add('leads', 'event_date', 'TEXT')
  add('leads', 'date_status', "TEXT CHECK (date_status IS NULL OR date_status IN ('verified','unverified','undated'))")
  add('leads', 'retrieved_at', 'INTEGER')
  add('leads', 'confidence', 'INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100)')
  add('leads', 'dedup_key', 'TEXT')
  add('leads', 'review_reason', 'TEXT')
  add('scan_jobs', 'candidates', 'INTEGER')
  add('scan_jobs', 'needs_review', 'INTEGER')
  add('scan_jobs', 'dropped', 'INTEGER')
  add('scan_jobs', 'drop_reasons', 'TEXT')
  add('scan_jobs', 'verified', 'INTEGER')
  add('scan_jobs', 'query', 'TEXT CHECK (query IS NULL OR length(query) <= 600)')
  add('scan_jobs', 'icp', 'TEXT CHECK (icp IS NULL OR length(icp) <= 4000)')
  add('scan_jobs', 'icp_inferred', 'INTEGER')
  add('scan_jobs', 'sources', 'TEXT CHECK (sources IS NULL OR length(sources) <= 2000)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS leads_dedup ON leads (scan_job_id, dedup_key) WHERE dedup_key IS NOT NULL')
}

export function createJob(db: Database.Database, userId: string, input: ScanInput): string {
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, ?, ?, ?)').run(
    id, userId, input.business_name, input.industry, input.location,
  )
  return id
}

// icp is a JSON string the user already saw and accepted/edited; null means "infer it when the job runs".
export function createQueryJob(db: Database.Database, userId: string, input: QueryInput): string {
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, sources) VALUES (?, ?, ?, '(from request)', '-', ?, ?, ?, ?)").run(
    id, userId, input.query.slice(0, 150) || '-', input.query, input.icp ?? null, input.icp ? 0 : null, input.sources ?? null,
  )
  return id
}

// Jobs stuck in 'running' past the timeout go back to 'pending' for another
// attempt, or to 'failed' after MAX_ATTEMPTS. Called on reads, so no cron needed.
export function reapStaleJobs(db: Database.Database): void {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_RUNNING_S
  db.prepare(
    `UPDATE scan_jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
       error = CASE WHEN attempts >= ? THEN 'timeout' ELSE error END,
       finished_at = CASE WHEN attempts >= ? THEN CAST(strftime('%s','now') AS INTEGER) ELSE finished_at END,
       claimed_at = NULL
     WHERE status = 'running' AND claimed_at < ?`,
  ).run(MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS, cutoff)
}

export function getJob(db: Database.Database, userId: string, id: string) {
  reapStaleJobs(db)
  const job = db
    .prepare('SELECT id, status, error, query, icp, icp_inferred, created_at, finished_at, candidates, verified, needs_review, dropped, drop_reasons FROM scan_jobs WHERE id = ? AND user_id = ?')
    .get(id, userId) as { id: string; status: string; error: string | null; query: string | null; icp: string | null; icp_inferred: number | null; created_at: number; finished_at: number | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; drop_reasons: string | null } | undefined
  if (!job) return undefined
  const { n } = db.prepare('SELECT count(*) AS n FROM leads WHERE scan_job_id = ?').get(id) as { n: number }
  return { ...job, lead_count: n }
}

export function countActiveJobs(db: Database.Database, userId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND status IN ('pending','running')").get(userId) as { n: number }).n
}

export function listLeads(db: Database.Database, userId: string, jobId: string, limit = 200) {
  return db
    .prepare(
      `SELECT l.id, l.scan_job_id, l.name, l.company, l.contact, l.signal, l.source_url, l.score, l.created_at,
         l.evidence_excerpt, l.event_date, l.date_status, l.retrieved_at, l.confidence, l.review_reason
       FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
       WHERE j.id = ? AND j.user_id = ? ORDER BY (l.confidence IS NULL), l.score DESC, l.created_at DESC LIMIT ?`,
    )
    .all(jobId, userId, Math.min(limit, 500))
}

export function latestJobId(db: Database.Database, userId: string): string | undefined {
  return (db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId) as { id: string } | undefined)?.id
}
