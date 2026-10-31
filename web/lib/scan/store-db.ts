// Scan job store on the Db layer (SQLite or Postgres): step 1 of "Plan: scan jobs to Postgres" in docs/PLATFORM.md.
// The same queries as the sync functions in store.ts, which stay the ones the app calls until each caller moves with
// its owner (the scan runner, routes and outreach are not switched here). test/scan-store-db.test.ts pins the two
// side by side on SQLite and runs these on Postgres, with two tenants.
// Differences from store.ts, all engine-neutral:
//   - times come from the caller's clock, not strftime('now'), so the SQL runs on both engines;
//   - same-second ties order by insert_seq (lib/db/insertion-order.ts), the insertion order both engines keep: on
//     SQLite it is the order rowid gave, so it lists exactly as store.ts does;
//   - getJob does not run the stale reaper as a side effect: reapStaleJobs is its own call.
// The status-transition and running-job triggers stay in the schema on both engines; nothing here bypasses them.
import { randomBytes } from 'node:crypto'
import type { Db, Param, Tx, TxBody } from '../db/client.ts'
import { CANCEL_HOLD_S, MAX_ATTEMPTS, STALE_RUNNING_S, type QueryInput, type ScanInput, type CancelResult, type JobSummary } from './store.ts'
import { ENRICH_STALE_S } from './enrichment.ts'

const nowS = () => Math.floor(Date.now() / 1000)

export async function createJob(db: Db, userId: string, input: ScanInput, runBudget: string | null = null, now = nowS()): Promise<string> {
  const id = randomBytes(12).toString('hex')
  await db.run('INSERT INTO scan_jobs (id, user_id, business_name, industry, location, run_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, input.business_name, input.industry, input.location, runBudget, now])
  return id
}

// icp is a JSON string the user already saw; null means "infer it when the job runs". run_budget is part of the
// INSERT, so a job is never visible to a runner without its budget.
const QUERY_JOB_SQL = "INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, sources, seller, offer, offer_set_at, watch_id, run_budget, created_at) VALUES (?, ?, ?, '(from request)', '-', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
const queryJobParams = (id: string, userId: string, input: QueryInput, now: number): Param[] => {
  const offer = (input.offer ?? '').replace(/\s+/g, ' ').trim().slice(0, 150) || null
  return [id, userId, input.query.slice(0, 150) || '-', input.query, input.icp ?? null, input.icp ? 0 : null, input.sources ?? null, (input.seller ?? '').trim().slice(0, 300) || null, offer, offer ? now : null, input.watchId ?? null, input.runBudget ?? null, now]
}
export async function createQueryJob(db: Db, userId: string, input: QueryInput, now = nowS()): Promise<string> {
  const id = randomBytes(12).toString('hex')
  await db.run(QUERY_JOB_SQL, queryJobParams(id, userId, input, now))
  return id
}
// createQueryJob as a transaction step, for a caller that records the job with other writes in one transaction (a
// watch or monitor run: the job and the schedule that queued it commit together, or neither does).
export function* queryJobStep(t: Tx, userId: string, input: QueryInput, now = nowS()): TxBody<string> {
  const id = randomBytes(12).toString('hex')
  yield* t.run(QUERY_JOB_SQL, queryJobParams(id, userId, input, now))
  return id
}

export function latestQueryJob(db: Db, userId: string): Promise<{ query: string | null; icp: string | null; icp_inferred: number | null } | undefined> {
  return db.get(`SELECT query, icp, icp_inferred FROM scan_jobs WHERE user_id = ? AND query IS NOT NULL ORDER BY created_at DESC, insert_seq DESC LIMIT 1`, [userId])
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

export type JobRow = { id: string; status: string; error: string | null; query: string | null; icp: string | null; icp_inferred: number | null; created_at: number; claimed_at: number | null; attempts: number; finished_at: number | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; drop_reasons: string | null; industry: string | null; location: string | null; enrich_started_at: number | null; enrich_finished_at: number | null; lead_count: number }

// Owner-scoped: another tenant's job id reads as not found.
export function getJob(db: Db, userId: string, id: string): Promise<JobRow | undefined> {
  return db.get<JobRow>(
    `SELECT id, status, error, query, icp, icp_inferred, created_at, claimed_at, attempts, finished_at, candidates, verified, needs_review, dropped, drop_reasons, industry, location, enrich_started_at, enrich_finished_at,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS lead_count
     FROM scan_jobs j WHERE id = ? AND user_id = ?`, [id, userId])
}

// CSV import jobs do not count; a just-cancelled scan keeps its slot for CANCEL_HOLD_S (its in-flight provider phase
// may still be running and billed).
export async function countActiveJobs(db: Db, userId: string, now = nowS()): Promise<number> {
  return Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND csv_domain IS NULL AND (status IN ('pending','running') OR (status = 'done' AND enrich_started_at IS NOT NULL AND enrich_finished_at IS NULL AND enrich_started_at > ?) OR (status = 'failed' AND error = 'cancelled' AND finished_at >= ?))", [userId, now - ENRICH_STALE_S, now - CANCEL_HOLD_S]))!.n)
}

// A lead a REQUIRED gate failed on whose review write was rejected still reads verified in leads.review_reason. The gate leaves a marker beside it (lead_enrichments, connector
// 'scan:gate', kind 'gate_failed'); every user-facing read of the lead row overlays it (SQLite and Postgres), so a held lead is never shown or exported as verified. A store
// without the enrichments table (an older SQLite database) reads the row as stored.
const HELD_MARK = "EXISTS (SELECT 1 FROM lead_enrichments h WHERE h.lead_id = l.id AND h.connector = 'scan:gate' AND h.kind = 'gate_failed')"
const HELD_REVIEW = `CASE WHEN l.review_reason IS NULL AND ${HELD_MARK} THEN 'sales_hiring_check_failed' ELSE l.review_reason END AS review_reason`
const HELD_CONF = `CASE WHEN l.review_reason IS NULL AND ${HELD_MARK} THEN NULL ELSE l.confidence END AS confidence`
async function allHeld(db: Db, plain: string, plainCols: string, heldCols: string, params: Param[]): Promise<Record<string, unknown>[]> {
  try { return await db.all(plain.replace(plainCols, heldCols), params) } catch (e) { if (!/no such table/i.test(e instanceof Error ? e.message : '')) throw e; return db.all(plain, params) }
}

const LEAD_COLUMNS = `l.id, l.scan_job_id, l.name, l.company, l.contact, l.signal, l.source_url, l.score, l.created_at,
l.evidence_excerpt, l.event_date, l.event_date_proof, l.event_date_proof_note, l.signal_kind, l.date_status, l.retrieved_at, l.confidence, l.review_reason, l.company_domain,
l.human_confirmed_at, l.human_confirmed_from, l.source_kind, l.quarantined_at, l.quarantine_reason, l.evidence_origin, l.own_fetch_failure, l.evidence_copy_sha256, l.evidence_copy_id, l.evidence_purged_at, l.timing_note, l.published_at,
l.fit, l.intent, l.action, l.why, l.signals, l.icp_match, l.watch_new, l.seen_before, l.stage`

// Ranked: scored leads first by ICP fit, then intent, actionability and evidence confidence. Low-fit scored leads
// (fit <= 1) are hidden unless includeHidden. Scoped through the job's owner.
export function listLeads(db: Db, userId: string, jobId: string, limit = 200, includeHidden = false): Promise<Record<string, unknown>[]> {
  return allHeld(db,
    `SELECT ${LEAD_COLUMNS}
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.id = ? AND j.user_id = ? ${includeHidden ? '' : 'AND (l.fit IS NULL OR l.fit > 1)'}
     ORDER BY (l.fit IS NULL), l.fit DESC, l.action DESC, (l.confidence IS NULL), l.confidence DESC, l.score DESC, l.created_at DESC, l.insert_seq LIMIT ?`,
    'l.confidence, l.review_reason,', `${HELD_CONF}, ${HELD_REVIEW},`, [jobId, userId, Math.min(limit, 500)])
}

export async function countHiddenLeads(db: Db, userId: string, jobId: string): Promise<number> {
  return Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.id = ? AND j.user_id = ? AND l.fit IS NOT NULL AND l.fit <= 1', [jobId, userId]))!.n)
}

export async function latestJobId(db: Db, userId: string): Promise<string | undefined> {
  return (await db.get<{ id: string }>(`SELECT id FROM scan_jobs WHERE user_id = ? ORDER BY created_at DESC, insert_seq DESC LIMIT 1`, [userId]))?.id
}

export function listJobs(db: Db, userId: string, limit = 20): Promise<JobSummary[]> {
  return db.all<JobSummary>(
    `SELECT j.id, j.status, j.error, j.query, j.business_name, j.industry, j.location, j.csv_domain, j.created_at, j.finished_at,
            j.candidates, j.verified, j.needs_review, j.dropped, j.enrich_started_at, j.enrich_finished_at,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS lead_count
     FROM scan_jobs j WHERE j.user_id = ?
     ORDER BY j.created_at DESC, j.insert_seq DESC LIMIT ?`, [userId, limit])
}

// CSV export: the tenant's visible leads (no hidden fit<=1, no quarantined), one job or all, newest first. Fixture
// rows (source_kind 'test') only with includeFixtures. Read-only.
export function exportLeads(db: Db, userId: string, jobId?: string, limit = 5000, includeFixtures = false): Promise<Record<string, unknown>[]> {
  return allHeld(db,
    `SELECT l.id AS lead_id, l.scan_job_id AS job_id, l.company, l.name, l.contact, l.signal, l.why, l.source_url,
            l.fit, l.intent, l.action, l.score, l.confidence, l.event_date, l.date_status, l.review_reason,
            l.human_confirmed_from, l.evidence_excerpt, l.evidence_origin, l.own_fetch_failure, l.evidence_purged_at, l.timing_note, l.published_at, l.created_at
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? ${jobId ? 'AND j.id = ?' : ''} AND (l.fit IS NULL OR l.fit > 1) AND l.quarantined_at IS NULL
     ${includeFixtures ? '' : "AND (l.source_kind IS NULL OR l.source_kind != 'test')"}
     ORDER BY l.created_at DESC, l.insert_seq LIMIT ?`,
    'l.confidence, l.event_date, l.date_status, l.review_reason,', `${HELD_CONF}, l.event_date, l.date_status, ${HELD_REVIEW},`, jobId ? [userId, jobId, limit] : [userId, limit])
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

// ---- Step 2 (storage half): ending an attempt in one transaction ----
// The writes the runner's finish() makes (lib/scan/runner.ts), on the Db layer: the attempt's leads and review rows
// and the job row, in one transaction, fenced on status='running' AND attempts=? (the attempt that was claimed). The
// caller computes the rows (dedup key, source kind, evidence copy id) exactly as today; this only stores them. Not
// wired in: the runner keeps its own finish() until its owners move it.
// One difference from finish(): finish() inserts with INSERT OR IGNORE, which on SQLite also drops a row that fails a
// CHECK; here only a duplicate is skipped (ON CONFLICT DO NOTHING, same on both engines), and an invalid row fails the
// whole transaction, so nothing of the attempt is half-written and the job stays 'running' for the reaper.
export interface LeadRow {
  name: string; company: string; contact: string | null; signal: string; source_url: string; score: number
  evidence_excerpt: string | null; event_date: string | null; date_status: string | null; retrieved_at: number | null
  confidence: number | null; dedup_key: string | null; fit?: number | null; intent?: number | null; action?: number | null
  why?: string | null; signals?: string | null; icp_match?: string | null; signal_kind?: string | null; source_kind?: string | null
  evidence_origin?: string | null; own_fetch_failure?: string | null; evidence_copy_sha256?: string | null; evidence_copy_id?: string | null
  // page timing (lib/scan/page-timing.ts): the publication day is a label, never the event date
  timing_note?: string | null; published_at?: string | null
}
export interface ReviewRow {
  name: string; company: string; signal: string; source_url: string; score: number; evidence_excerpt: string | null
  event_date: string | null; dedup_key: string; review_reason: string; source_kind?: string | null
  timing_note?: string | null; published_at?: string | null
}
export interface FinishInput {
  status: 'done' | 'failed' | 'pending'
  error: string | null
  leads?: LeadRow[]
  review?: ReviewRow[]
  candidates?: number | null
  dropped?: Record<string, number> | null
  now?: number
}
export type FinishResult = { owned: false } | { owned: true; inserted: string[] }

export function finishJob(db: Db, job: { id: string; attempts: number }, input: FinishInput): Promise<FinishResult> {
  const now = input.now ?? nowS()
  const leads = input.leads ?? [], review = input.review ?? []
  return db.tx(function* (t): TxBody<FinishResult> {
    const own = yield* t.get(`SELECT 1 AS x FROM scan_jobs WHERE id = ? AND status = 'running' AND attempts = ?${t.kind === 'pg' ? ' FOR UPDATE' : ''}`, [job.id, job.attempts])
    if (!own) return { owned: false }
    const inserted: string[] = []
    for (const l of leads) {
      const r = yield* t.run(
        `INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, fit, intent, action, why, signals, icp_match, signal_kind, source_kind, evidence_origin, own_fetch_failure, evidence_copy_sha256, evidence_copy_id, timing_note, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [randomBytes(12).toString('hex'), job.id, l.name, l.company, l.contact, l.signal, l.source_url, l.score, l.evidence_excerpt, l.event_date, l.date_status, l.retrieved_at, l.confidence, l.dedup_key,
          l.fit ?? null, l.intent ?? null, l.action ?? null, l.why ?? null, l.signals ?? null, l.icp_match ?? null, l.signal_kind ?? null, l.source_kind ?? null, l.evidence_origin ?? null, l.own_fetch_failure ?? null, l.evidence_copy_sha256 ?? null, l.evidence_copy_id ?? null, l.timing_note ?? null, l.published_at ?? null, now])
      if (r.changes) inserted.push(`${l.dedup_key}|${l.source_url}`)
    }
    for (const l of review) {
      const r = yield* t.run(
        `INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, review_reason, source_kind, timing_note, published_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [randomBytes(12).toString('hex'), job.id, l.name, l.company, l.signal, l.source_url, l.score, l.evidence_excerpt, l.event_date, l.event_date ? 'unverified' : 'undated', l.dedup_key, l.review_reason, l.source_kind ?? null, l.timing_note ?? null, l.published_at ?? null, now])
      if (r.changes) inserted.push(`${l.dedup_key}|${l.source_url}`)
    }
    const dropped = input.dropped ? Object.values(input.dropped).reduce((a, b) => a + b, 0) : null
    yield* t.run(
      `UPDATE scan_jobs SET status = ?, error = ?, claimed_at = NULL, candidates = ?, verified = ?, needs_review = ?, dropped = ?, drop_reasons = ?,
         finished_at = ? WHERE id = ?`,
      [input.status, input.error, input.candidates ?? null, input.status === 'done' ? leads.length : null, input.status === 'done' ? review.length : null,
        dropped, input.dropped ? JSON.stringify(input.dropped) : null, input.status === 'pending' ? null : now, job.id])
    return { owned: true, inserted }
  })
}

// failOrRetry's storage step: after a retryable error the attempt goes back to 'pending' until MAX_ATTEMPTS, then
// fails; a non-retryable one (a rejected key, a timeout, a refused spend) fails at once. 'stale' when this attempt no
// longer owns the job (cancelled, finished, re-claimed): nothing is written.
export async function failOrRequeue(db: Db, job: { id: string; attempts: number }, error: string, opts: { retryable: boolean; now?: number }): Promise<'retry' | 'failed' | 'stale'> {
  const status = opts.retryable && job.attempts < MAX_ATTEMPTS ? 'pending' : 'failed'
  const r = await finishJob(db, job, { status, error: error.slice(0, 200), now: opts.now })
  return !r.owned ? 'stale' : status === 'pending' ? 'retry' : 'failed'
}
