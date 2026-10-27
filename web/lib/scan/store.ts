import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { primarySignalKind } from './score.ts'
import { migrateSourceRuns } from './source-runs.ts'
import { migrateEvidenceCopies } from './evidence-copies.ts'
import { migrateRunReport } from './run-report.ts'

export const STALE_RUNNING_S = Number(process.env.SCAN_STALE_RUNNING_S || 20 * 60)
export const MAX_ATTEMPTS = 3
export const CANCEL_HOLD_S = 5 * 60

export interface ScanInput {
  business_name: string
  industry: string
  location: string
}
// Free-text request. The legacy columns stay filled (placeholders) so older workers keep working.
export interface QueryInput { query: string; icp?: string | null; sources?: string | null; seller?: string; watchId?: string; runBudget?: string | null }

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
  `)
  try { db.exec("ALTER TABLE scan_jobs ADD COLUMN funded_by TEXT NOT NULL DEFAULT 'user'") } catch { /* column exists */ }
  db.exec(`
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
  migrateSourceRuns(db)
  migrateEvidenceCopies(db)
  migrateRunReport(db)
}

// Evidence columns. Nullable, so rows written by other workers (Hermes) stay valid:
// a lead with no evidence_excerpt was not verified by dazl.
function addColumns(db: Database.Database): void {
  const has = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some(r => r.name === c)
  const add = (t: string, c: string, def: string) => { if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`) }
  add('scan_jobs', 'seller', 'TEXT')
  add('leads', 'stage', 'TEXT')
  add('scan_jobs', 'watch_id', 'TEXT')
  add('leads', 'watch_new', 'INTEGER NOT NULL DEFAULT 0')
  add('leads', 'evidence_excerpt', 'TEXT CHECK (evidence_excerpt IS NULL OR length(evidence_excerpt) <= 400)')
  add('leads', 'icp_match', 'TEXT CHECK (icp_match IS NULL OR length(icp_match) <= 400)')
  add('leads', 'event_date', 'TEXT')
  add('leads', 'date_status', "TEXT CHECK (date_status IS NULL OR date_status IN ('verified','unverified','undated'))")
  add('leads', 'retrieved_at', 'INTEGER')
  add('leads', 'confidence', 'INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100)')
  add('leads', 'dedup_key', 'TEXT')
  add('leads', 'review_reason', 'TEXT')
  add('leads', 'evidence_origin', "TEXT CHECK (evidence_origin IS NULL OR evidence_origin IN ('tinyfish_copy'))") // verified against text TinyFish fetched, not dazl's own read (scan/held-text.ts)
  add('leads', 'own_fetch_failure', 'TEXT') // dazl's own fetch failure for that page, kept beside the copy
  add('leads', 'evidence_copy_sha256', 'TEXT') // hash of the exact copied text that was checked
  add('leads', 'evidence_purged_at', 'INTEGER') // the copied text was deleted on the tenant's request (audited); the lead keeps its origin label
  add('leads', 'timing_note', 'TEXT CHECK (timing_note IS NULL OR length(timing_note) <= 300)') // how a missing date was resolved from the page, or a season label with no date
  add('leads', 'evidence_copy_id', 'TEXT') // lead_evidence_copies.id: the preserved original text (scan/evidence-copies.ts)
  add('leads', 'human_confirmed_at', 'INTEGER') // the user checked this needs-review lead against its source and chose to use it
  add('leads', 'human_confirmed_from', 'TEXT') // the review_reason it was confirmed out of - provenance, never overwritten
  add('leads', 'company_domain', 'TEXT CHECK (company_domain IS NULL OR length(company_domain) <= 253)')
  add('leads', 'quarantined_at', 'INTEGER') // the user quarantined this lead: kept with its evidence, never drafted, sent or exported (scan/quarantine.ts)
  add('leads', 'quarantine_reason', 'TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) <= 300)')
  add('scan_jobs', 'candidates', 'INTEGER')
  add('scan_jobs', 'needs_review', 'INTEGER')
  add('scan_jobs', 'dropped', 'INTEGER')
  add('scan_jobs', 'run_budget', 'TEXT') // per-run budget controls (CSV company imports and POST /api/scan); null = current behavior
  add('scan_jobs', 'spend_reserved_usd', 'REAL') // what this job has already RESERVED under max_usd, saved per call so a retry/restart continues from it
  add('scan_jobs', 'drop_reasons', 'TEXT')
  add('scan_jobs', 'verified', 'INTEGER')
  add('scan_jobs', 'query', 'TEXT CHECK (query IS NULL OR length(query) <= 600)')
  add('scan_jobs', 'icp', 'TEXT CHECK (icp IS NULL OR length(icp) <= 4000)')
  add('scan_jobs', 'icp_inferred', 'INTEGER')
  add('scan_jobs', 'sources', 'TEXT CHECK (sources IS NULL OR length(sources) <= 2000)')
  // Lead scoring (ICP fit / intent / actionability, 0-5 each) + per-lead rationale and signals.
  add('leads', 'fit', 'INTEGER CHECK (fit IS NULL OR fit BETWEEN 0 AND 5)')
  add('leads', 'intent', 'INTEGER CHECK (intent IS NULL OR intent BETWEEN 0 AND 5)')
  add('leads', 'action', 'INTEGER CHECK (action IS NULL OR action BETWEEN 0 AND 5)')
  add('leads', 'why', 'TEXT CHECK (why IS NULL OR length(why) <= 600)')
  add('leads', 'signals', 'TEXT CHECK (signals IS NULL OR length(signals) <= 1000)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS leads_dedup ON leads (scan_job_id, dedup_key) WHERE dedup_key IS NOT NULL')
  add('leads', 'seen_before', 'INTEGER NOT NULL DEFAULT 0')
  // Normalized attribution tags, filled at write time from data the pipeline already has:
  // signal_kind = the grader's primary signal id; source_kind = the producing channel.
  add('leads', 'signal_kind', 'TEXT')
  add('leads', 'source_kind', 'TEXT')
  // CSV bulk import: a job created from an uploaded domain list carries the domain it
  // researches and the batch it belongs to. NULL on every manual/watch scan.
  add('scan_jobs', 'csv_domain', 'TEXT CHECK (csv_domain IS NULL OR length(csv_domain) <= 253)')
  add('scan_jobs', 'batch_id', 'TEXT')
  widenWhyCap(db)
  backfillKindTags(db)
}


// One-time, idempotent backfill for rows written before the tag columns existed. Uses only
// data already stored: the grader's signals JSON, scan_jobs fields, and known fixture names.
// Unknown or unrecognized values stay NULL - the tags never invent a kind.
function backfillKindTags(db: Database.Database): void {
  const hasTable = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
  db.exec(`UPDATE leads SET source_kind = (
    SELECT CASE
      WHEN j.watch_id IS NOT NULL THEN 'watch'
      WHEN j.csv_domain IS NOT NULL THEN 'csv'
      ELSE 'query' END
    FROM scan_jobs j WHERE j.id = leads.scan_job_id)
    WHERE source_kind IS NULL`)
  if (hasTable('commenter_batches')) db.exec(`UPDATE leads SET source_kind = 'commenter', signal_kind = COALESCE(signal_kind, 'competitor_complaint')
    WHERE scan_job_id IN (SELECT job_id FROM commenter_batches)`)
  if (hasTable('monitor_runs')) db.exec(`UPDATE leads SET source_kind = 'monitor'
    WHERE scan_job_id IN (SELECT job_id FROM monitor_runs)`)
  // Fixture rows, grounded in the fixture inserters' own job-level marker:
  // test-fixture, verification-fixture and ranking-fixture all insert their jobs
  // with industry/location 'test only' (and tag new leads source_kind 'test' at
  // insert). Older fixture rows predate the column - mark them by the JOB marker
  // so no business-name matching can ever hide a genuine company's row.
  db.exec(`UPDATE leads SET source_kind = 'test' WHERE scan_job_id IN (SELECT id FROM scan_jobs WHERE industry = 'test only' AND location = 'test only')`)
  const rows = db.prepare('SELECT id, signals FROM leads WHERE signal_kind IS NULL AND signals IS NOT NULL').all() as { id: string; signals: string }[]
  const upd = db.prepare('UPDATE leads SET signal_kind = ? WHERE id = ?')
  for (const r of rows) { const k = primarySignalKind(r.signals); if (k) upd.run(k, r.id) }
}

// Score reasoning grew from one sentence to 2-3 (cap 300 -> 600). SQLite cannot alter a
// column CHECK, so databases that already carry the 300 cap get the leads table rebuilt
// with the wider one. The rebuild preserves every row, index and trigger. No-op on
// fresh databases and on databases already at 600.
function widenWhyCap(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'").get() as { sql: string } | undefined
  if (!row || !row.sql.includes('length(why) <= 300)')) return
  const widened = row.sql.replace(/CREATE TABLE leads\b/, 'CREATE TABLE leads_new').replace('length(why) <= 300)', 'length(why) <= 600)')
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(widened)
      db.exec('INSERT INTO leads_new SELECT * FROM leads')
      db.exec('DROP TABLE leads')
      db.exec('ALTER TABLE leads_new RENAME TO leads')
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  // Indexes and triggers on leads were dropped with the old table; restore them.
  db.exec(`
    CREATE INDEX IF NOT EXISTS leads_job ON leads (scan_job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS leads_dedup ON leads (scan_job_id, dedup_key) WHERE dedup_key IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS leads_only_while_running
    BEFORE INSERT ON leads
    WHEN (SELECT status FROM scan_jobs WHERE id = NEW.scan_job_id) IS NOT 'running'
    BEGIN SELECT RAISE(ABORT, 'leads can only be added to a running job'); END;
  `)
}

export function createJob(db: Database.Database, userId: string, input: ScanInput, runBudget: string | null = null): string {
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO scan_jobs (id, user_id, business_name, industry, location, run_budget) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, userId, input.business_name, input.industry, input.location, runBudget,
  )
  return id
}

// icp is a JSON string the user already saw and accepted/edited; null means "infer it when the job runs".
export function createQueryJob(db: Database.Database, userId: string, input: QueryInput): string {
  const id = randomBytes(12).toString('hex')
  // run_budget is part of the INSERT, so a job is never visible to the runner without its budget.
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, sources, seller, watch_id, run_budget) VALUES (?, ?, ?, '(from request)', '-', ?, ?, ?, ?, ?, ?, ?)").run(
    id, userId, input.query.slice(0, 150) || '-', input.query, input.icp ?? null, input.icp ? 0 : null, input.sources ?? null, (input.seller ?? '').trim().slice(0, 300) || null, input.watchId ?? null, input.runBudget ?? null,
  )
  return id
}

// The tenant's most recent query scan - feeds the "your profile is still here" restore on the leads page.
export function latestQueryJob(db: Database.Database, userId: string): { query: string | null; icp: string | null; icp_inferred: number | null } | undefined {
  return db.prepare('SELECT query, icp, icp_inferred FROM scan_jobs WHERE user_id = ? AND query IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId) as { query: string | null; icp: string | null; icp_inferred: number | null } | undefined
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
    .prepare('SELECT id, status, error, query, icp, icp_inferred, created_at, claimed_at, attempts, finished_at, candidates, verified, needs_review, dropped, drop_reasons, industry, location FROM scan_jobs WHERE id = ? AND user_id = ?')
    .get(id, userId) as { id: string; status: string; error: string | null; query: string | null; icp: string | null; icp_inferred: number | null; created_at: number; claimed_at: number | null; attempts: number; finished_at: number | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; drop_reasons: string | null; industry: string | null; location: string | null } | undefined
  if (!job) return undefined
  const { n } = db.prepare('SELECT count(*) AS n FROM leads WHERE scan_job_id = ?').get(id) as { n: number }
  return { ...job, lead_count: n }
}

export function countActiveJobs(db: Database.Database, userId: string): number {
  // CSV import jobs do not count: a 50-domain batch must not lock the user out of manual scans.
  // A just-cancelled scan keeps its slot for CANCEL_HOLD_S: its in-flight provider phase cannot be interrupted
  // and may still be running, so freeing the slot at once would let a user stack paid work.
  const holdFrom = Math.floor(Date.now() / 1000) - CANCEL_HOLD_S
  return (db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND csv_domain IS NULL AND (status IN ('pending','running') OR (status = 'failed' AND error = 'cancelled' AND finished_at >= ?))").get(userId, holdFrom) as { n: number }).n
}

// Ranked: scored leads first by ICP fit, then intent, actionability and evidence confidence.
// Low-fit scored leads (fit <= 1) are hidden unless includeHidden - they stay in the scan.
export function listLeads(db: Database.Database, userId: string, jobId: string, limit = 200, includeHidden = false) {
  return db
    .prepare(
      `SELECT l.id, l.scan_job_id, l.name, l.company, l.contact, l.signal, l.source_url, l.score, l.created_at,
l.evidence_excerpt, l.event_date, l.date_status, l.retrieved_at, l.confidence, l.review_reason, l.company_domain,
l.human_confirmed_at, l.human_confirmed_from, l.source_kind, l.quarantined_at, l.quarantine_reason, l.evidence_origin, l.own_fetch_failure, l.evidence_copy_sha256, l.evidence_copy_id, l.evidence_purged_at, l.timing_note,
         l.fit, l.intent, l.action, l.why, l.signals, l.icp_match, l.watch_new, l.seen_before, l.stage
       FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
       WHERE j.id = ? AND j.user_id = ? ${includeHidden ? '' : 'AND (l.fit IS NULL OR l.fit > 1)'}
       ORDER BY (l.fit IS NULL), l.fit DESC, l.action DESC, (l.confidence IS NULL), l.confidence DESC, l.score DESC, l.created_at DESC LIMIT ?`,
    )
    .all(jobId, userId, Math.min(limit, 500))
}

export function countHiddenLeads(db: Database.Database, userId: string, jobId: string): number {
  return (db.prepare('SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.id = ? AND j.user_id = ? AND l.fit IS NOT NULL AND l.fit <= 1').get(jobId, userId) as { n: number }).n
}

// Cross-scan dedupe: flag leads whose company already appeared in one of the user's EARLIER
// jobs (by company domain, else normalized company name). Repeat and watch runs re-surface the
// same companies; the flag lets the UI tuck them behind a toggle instead of showing them as fresh.
export function markSeenBefore(db: Database.Database, userId: string, jobId: string, keyOf: (company: string) => string): number {
  const job = db.prepare('SELECT created_at, rowid AS r FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, userId) as { created_at: number; r: number } | undefined
  if (!job) return 0
  const prior = db.prepare('SELECT l.company, l.company_domain, j.rowid AS jr FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND j.rowid < ? AND l.review_reason IS NULL').all(userId, job.r) as { company: string; company_domain: string | null }[]
  if (prior.length === 0) return 0
  const domains = new Set(prior.map(p => p.company_domain?.toLowerCase()).filter((d): d is string => !!d))
  const names = new Set(prior.map(p => keyOf(p.company)))
  const mine = db.prepare('SELECT id, company, company_domain FROM leads WHERE scan_job_id = ? AND review_reason IS NULL').all(jobId) as { id: string; company: string; company_domain: string | null }[]
  const mark = db.prepare('UPDATE leads SET seen_before = 1 WHERE id = ?')
  let n = 0
  for (const l of mine) {
    if ((l.company_domain && domains.has(l.company_domain.toLowerCase())) || (l.company && names.has(keyOf(l.company)))) { mark.run(l.id); n++ }
  }
  return n
}

export function latestJobId(db: Database.Database, userId: string): string | undefined {
  return (db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId) as { id: string } | undefined)?.id
}

// History list for the leads page: the tenant's own past scans, newest first, one row per job.
// Explicit selection only - the UI links each row to /app/leads?job_id=<id>; nothing autoselects.
export interface JobSummary {
  id: string
  status: string
  error: string | null
  query: string | null
  business_name: string
  industry: string
  location: string
  csv_domain: string | null
  created_at: number
  finished_at: number | null
  candidates: number | null
  verified: number | null
  needs_review: number | null
  dropped: number | null
  lead_count: number
}
export function listJobs(db: Database.Database, userId: string, limit = 20): JobSummary[] {
  return db
    .prepare(
      `SELECT j.id, j.status, j.error, j.query, j.business_name, j.industry, j.location, j.csv_domain, j.created_at, j.finished_at,
              j.candidates, j.verified, j.needs_review, j.dropped,
              (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS lead_count
       FROM scan_jobs j
       WHERE j.user_id = ?
       ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`,
    )
    .all(userId, limit) as JobSummary[]
}

// CSV export: every lead the tenant can see (hidden fit<=1 rows excluded unless
// includeHidden), across one job or all of their jobs, newest first. Read-only.
// Fixture provenance is the structured source_kind = 'test' classification: the
// fixture inserters set it at insert and migrateScan backfills older rows via the
// job-level 'test only' industry/location marker. No business-name matching, so a
// genuine company whose name happens to contain '(test only)' is never hidden.
// The export defaults to real rows only; includeFixtures is the explicit opt-in for
// verification workflows. Nothing is deleted - every row stays in the database.
export function exportLeads(db: Database.Database, userId: string, jobId?: string, limit = 5000, includeFixtures = false) {
  return db
    .prepare(
      `SELECT l.id AS lead_id, l.scan_job_id AS job_id, l.company, l.name, l.contact, l.signal, l.why, l.source_url,
              l.fit, l.intent, l.action, l.score, l.confidence, l.event_date, l.date_status, l.review_reason,
              l.human_confirmed_from, l.evidence_excerpt, l.evidence_origin, l.own_fetch_failure, l.evidence_purged_at, l.timing_note, l.created_at
       FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
       WHERE j.user_id = ? ${jobId ? 'AND j.id = ?' : ''} AND (l.fit IS NULL OR l.fit > 1) AND l.quarantined_at IS NULL
       ${includeFixtures ? '' : "AND (l.source_kind IS NULL OR l.source_kind != 'test')"}
       ORDER BY l.created_at DESC LIMIT ?`,
    )
    .all(...(jobId ? [userId, jobId, limit] : [userId, limit]))
}


export type CancelResult = { ok: true; was_running: boolean } | { ok: false; reason: 'not_found' | 'already_finished' | 'not_cancellable' }

// Stop-requested, not provider-stopped. This only moves the job to its terminal failed
// state ('cancelled'). Every later write by the runner is fenced on status='running' AND
// attempts=?, so a late result is rejected and the stale reaper cannot re-claim it. An
// already-awaited provider call is NOT interrupted and may still be billed.
// Quota: a cancelled job keeps its monthly/trial charge (plans.ts and trial.ts only refund genuine failures),
// because provider work may already have been billed. No schema change: pending jobs take the legal pending->running->failed path in one transaction.
export function cancelJob(db: Database.Database, userId: string, id: string): CancelResult {
  return db.transaction((): CancelResult => {
    const j = db.prepare('SELECT status, csv_domain FROM scan_jobs WHERE id = ? AND user_id = ?').get(id, userId) as { status: string; csv_domain: string | null } | undefined
    if (!j) return { ok: false, reason: 'not_found' }
    if (j.status === 'done' || j.status === 'failed') return { ok: false, reason: 'already_finished' }
    if (j.csv_domain !== null) return { ok: false, reason: 'not_cancellable' }
    const wasRunning = j.status === 'running'
    if (!wasRunning) db.prepare("UPDATE scan_jobs SET status='running', attempts = attempts + 1, claimed_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ? AND status='pending'").run(id)
    const r = db.prepare("UPDATE scan_jobs SET status='failed', error='cancelled', claimed_at=NULL, finished_at=CAST(strftime('%s','now') AS INTEGER) WHERE id = ? AND user_id = ? AND status='running'").run(id, userId)
    return r.changes === 1 ? { ok: true, was_running: wasRunning } : { ok: false, reason: 'already_finished' }
  }).immediate()
}
