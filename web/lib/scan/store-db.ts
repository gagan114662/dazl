// Scan job store on the Db layer (SQLite or Postgres): step 1 of "Plan: scan jobs to Postgres" in docs/PLATFORM.md.
// The same queries as the sync functions in store.ts, which stay the ones the app calls until each caller moves with
// its owner (the scan runner, routes and outreach are not switched here). test/scan-store-db.test.ts pins the two
// side by side on SQLite and runs these on Postgres, with two tenants.
// Differences from store.ts, all engine-neutral:
//   - times come from the caller's clock, not strftime('now'), so the SQL runs on both engines;
//   - same-second ties order by id instead of SQLite's rowid (Postgres has none), so two jobs created in the same
//     second can list in a different order than store.ts lists them;
//   - getJob does not run the stale reaper as a side effect: reapStaleJobs is its own call.
// The status-transition and running-job triggers stay in the schema on both engines; nothing here bypasses them.
import { randomBytes } from 'node:crypto'
import type { Db, TxBody } from '../db/client.ts'
import { CANCEL_HOLD_S, MAX_ATTEMPTS, STALE_RUNNING_S, type QueryInput, type ScanInput, type CancelResult, type JobSummary } from './store.ts'

const nowS = () => Math.floor(Date.now() / 1000)

export async function createJob(db: Db, userId: string, input: ScanInput, runBudget: string | null = null, now = nowS()): Promise<string> {
  const id = randomBytes(12).toString('hex')
  await db.run('INSERT INTO scan_jobs (id, user_id, business_name, industry, location, run_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, input.business_name, input.industry, input.location, runBudget, now])
  return id
}

// icp is a JSON string the user already saw; null means "infer it when the job runs". run_budget is part of the
// INSERT, so a job is never visible to a runner without its budget.
export async function createQueryJob(db: Db, userId: string, input: QueryInput, now = nowS()): Promise<string> {
  const id = randomBytes(12).toString('hex')
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, sources, seller, watch_id, run_budget, created_at) VALUES (?, ?, ?, '(from request)', '-', ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, userId, input.query.slice(0, 150) || '-', input.query, input.icp ?? null, input.icp ? 0 : null, input.sources ?? null, (input.seller ?? '').trim().slice(0, 300) || null, input.watchId ?? null, input.runBudget ?? null, now])
  return id
}

export function latestQueryJob(db: Db, userId: string): Promise<{ query: string | null; icp: string | null; icp_inferred: number | null } | undefined> {
  return db.get('SELECT query, icp, icp_inferred FROM scan_jobs WHERE user_id = ? AND query IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1', [userId])
}

// Jobs stuck in 'running' past the timeout go back to 'pending', or to 'failed' ('timeout') after MAX_ATTEMPTS.
export async function reapStaleJobs(db: Db, now = nowS()): Promise<number> {
  return (await db.run(
    `UPDATE scan_jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
       error = CASE WHEN attempts >= ? THEN 'timeout' ELSE error END,
       finished_at = CASE WHEN attempts >= ? THEN ? ELSE finished_at END,
       claimed_at = NULL
     WHERE status = 'running' AND claimed_at < ?`,
    [MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS, now, now - STALE_RUNNING_S])).changes
}

export type JobRow = { id: string; status: string; error: string | null; query: string | null; icp: string | null; icp_inferred: number | null; created_at: number; claimed_at: number | null; attempts: number; finished_at: number | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; drop_reasons: string | null; industry: string | null; location: string | null; lead_count: number }

// Owner-scoped: another tenant's job id reads as not found.
export function getJob(db: Db, userId: string, id: string): Promise<JobRow | undefined> {
  return db.get<JobRow>(
    `SELECT id, status, error, query, icp, icp_inferred, created_at, claimed_at, attempts, finished_at, candidates, verified, needs_review, dropped, drop_reasons, industry, location,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS lead_count
     FROM scan_jobs j WHERE id = ? AND user_id = ?`, [id, userId])
}

// CSV import jobs do not count; a just-cancelled scan keeps its slot for CANCEL_HOLD_S (its in-flight provider phase
// may still be running and billed).
export async function countActiveJobs(db: Db, userId: string, now = nowS()): Promise<number> {
  return Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND csv_domain IS NULL AND (status IN ('pending','running') OR (status = 'failed' AND error = 'cancelled' AND finished_at >= ?))", [userId, now - CANCEL_HOLD_S]))!.n)
}

const LEAD_COLUMNS = `l.id, l.scan_job_id, l.name, l.company, l.contact, l.signal, l.source_url, l.score, l.created_at,
l.evidence_excerpt, l.event_date, l.date_status, l.retrieved_at, l.confidence, l.review_reason, l.company_domain,
l.human_confirmed_at, l.human_confirmed_from, l.source_kind, l.quarantined_at, l.quarantine_reason, l.evidence_origin, l.own_fetch_failure, l.evidence_copy_sha256, l.evidence_copy_id, l.evidence_purged_at,
l.fit, l.intent, l.action, l.why, l.signals, l.icp_match, l.watch_new, l.seen_before, l.stage`

// Ranked: scored leads first by ICP fit, then intent, actionability and evidence confidence. Low-fit scored leads
// (fit <= 1) are hidden unless includeHidden. Scoped through the job's owner.
export function listLeads(db: Db, userId: string, jobId: string, limit = 200, includeHidden = false): Promise<Record<string, unknown>[]> {
  return db.all(
    `SELECT ${LEAD_COLUMNS}
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.id = ? AND j.user_id = ? ${includeHidden ? '' : 'AND (l.fit IS NULL OR l.fit > 1)'}
     ORDER BY (l.fit IS NULL), l.fit DESC, l.action DESC, (l.confidence IS NULL), l.confidence DESC, l.score DESC, l.created_at DESC, l.id DESC LIMIT ?`,
    [jobId, userId, Math.min(limit, 500)])
}

export async function countHiddenLeads(db: Db, userId: string, jobId: string): Promise<number> {
  return Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.id = ? AND j.user_id = ? AND l.fit IS NOT NULL AND l.fit <= 1', [jobId, userId]))!.n)
}

export async function latestJobId(db: Db, userId: string): Promise<string | undefined> {
  return (await db.get<{ id: string }>('SELECT id FROM scan_jobs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [userId]))?.id
}

export function listJobs(db: Db, userId: string, limit = 20): Promise<JobSummary[]> {
  return db.all<JobSummary>(
    `SELECT j.id, j.status, j.error, j.query, j.business_name, j.industry, j.location, j.csv_domain, j.created_at, j.finished_at,
            j.candidates, j.verified, j.needs_review, j.dropped,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS lead_count
     FROM scan_jobs j WHERE j.user_id = ?
     ORDER BY j.created_at DESC, j.id DESC LIMIT ?`, [userId, limit])
}

// CSV export: the tenant's visible leads (no hidden fit<=1, no quarantined), one job or all, newest first. Fixture
// rows (source_kind 'test') only with includeFixtures. Read-only.
export function exportLeads(db: Db, userId: string, jobId?: string, limit = 5000, includeFixtures = false): Promise<Record<string, unknown>[]> {
  return db.all(
    `SELECT l.id AS lead_id, l.scan_job_id AS job_id, l.company, l.name, l.contact, l.signal, l.why, l.source_url,
            l.fit, l.intent, l.action, l.score, l.confidence, l.event_date, l.date_status, l.review_reason,
            l.human_confirmed_from, l.evidence_excerpt, l.evidence_origin, l.own_fetch_failure, l.evidence_purged_at, l.created_at
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? ${jobId ? 'AND j.id = ?' : ''} AND (l.fit IS NULL OR l.fit > 1) AND l.quarantined_at IS NULL
     ${includeFixtures ? '' : "AND (l.source_kind IS NULL OR l.source_kind != 'test')"}
     ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    jobId ? [userId, jobId, limit] : [userId, limit])
}

// Stop-requested, not provider-stopped: moves the job to failed/'cancelled' in one transaction (a pending job takes
// the legal pending -> running -> failed path). Every later runner write is fenced on status='running' AND attempts.
export function cancelJob(db: Db, userId: string, id: string, now = nowS()): Promise<CancelResult> {
  return db.tx(function* (t): TxBody<CancelResult> {
    const j = yield* t.get<{ status: string; csv_domain: string | null }>('SELECT status, csv_domain FROM scan_jobs WHERE id = ? AND user_id = ?', [id, userId])
    if (!j) return { ok: false, reason: 'not_found' }
    if (j.status === 'done' || j.status === 'failed') return { ok: false, reason: 'already_finished' }
    if (j.csv_domain !== null) return { ok: false, reason: 'not_cancellable' }
    const wasRunning = j.status === 'running'
    if (!wasRunning) yield* t.run("UPDATE scan_jobs SET status = 'running', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status = 'pending'", [now, id])
    const r = yield* t.run("UPDATE scan_jobs SET status = 'failed', error = 'cancelled', claimed_at = NULL, finished_at = ? WHERE id = ? AND user_id = ? AND status = 'running'", [now, id, userId])
    return r.changes === 1 ? { ok: true, was_running: wasRunning } : { ok: false, reason: 'already_finished' }
  })
}
