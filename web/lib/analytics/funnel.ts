// The two funnel steps that are "first" only by what the scan store says (#1616): an account's first search started,
// and its first search that finished. Both read scan_jobs and call track() (lib/analytics/track.ts); neither throws.
// CSV and other imports (csv_domain set) are not searches and never count.
import type Database from 'better-sqlite3'
import { track, type TrackDeps } from './track.ts'

// Call after the job row is committed. Fires only when it is the account's only search so far.
export function searchStarted(db: Database.Database, tenantId: string, jobId: string, trial: boolean, d: TrackDeps = {}): boolean {
  try {
    const r = db.prepare('SELECT count(*) AS n, sum(id = ?) AS me FROM scan_jobs WHERE user_id = ? AND csv_domain IS NULL').get(jobId, tenantId) as { n: number; me: number | null }
    return r.n === 1 && r.me === 1 && track('first_search_started', tenantId, { job_id: jobId, trial }, d)
  } catch { return false }
}

// Call after the job is written as done. Fires only when it is the account's only finished search so far.
export function searchFinished(db: Database.Database, tenantId: string, jobId: string, leads: number, needsReview: number, d: TrackDeps = {}): boolean {
  try {
    const r = db.prepare("SELECT count(*) AS n, sum(id = ?) AS me FROM scan_jobs WHERE user_id = ? AND csv_domain IS NULL AND status = 'done'").get(jobId, tenantId) as { n: number; me: number | null }
    return r.n === 1 && r.me === 1 && track('first_search_finished', tenantId, { job_id: jobId, count: leads, needs_review: needsReview }, d)
  } catch { return false }
}
