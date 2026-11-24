// The two funnel steps that are "first" only by what the scan store says (#1616): an account's first search started,
// and its first search that finished. Both read scan_jobs on the Db layer and call track() (lib/analytics/track.ts).
// Neither rejects: a store that cannot be read resolves false. Callers fire and forget (`void searchStarted(...)`).
// CSV and other imports (csv_domain set) are not searches and never count.
import type { Db } from '../db/client.ts'
import { track, type TrackDeps } from './track.ts'

type Counts = { n: number | string; me: number | string | null }
// count(*) and sum() come back as strings (bigint/numeric) on Postgres and numbers on SQLite.
const onlyMine = (r: Counts | undefined): boolean => !!r && Number(r.n) === 1 && Number(r.me) === 1
const MINE = 'SELECT count(*) AS n, sum(CASE WHEN id = ? THEN 1 ELSE 0 END) AS me FROM scan_jobs WHERE user_id = ? AND csv_domain IS NULL'

// Call after the job row is committed. Fires only when it is the account's only search so far.
export async function searchStarted(db: Db | Promise<Db>, tenantId: string, jobId: string, trial: boolean, d: TrackDeps = {}): Promise<boolean> {
  try {
    const r = await (await db).get<Counts>(MINE, [jobId, tenantId])
    return onlyMine(r) && track('first_search_started', tenantId, { job_id: jobId, trial }, d)
  } catch { return false }
}

// Call after the job is written as done. Fires only when it is the account's only finished search so far.
export async function searchFinished(db: Db | Promise<Db>, tenantId: string, jobId: string, leads: number, needsReview: number, d: TrackDeps = {}): Promise<boolean> {
  try {
    const r = await (await db).get<Counts>(`${MINE} AND status = 'done'`, [jobId, tenantId])
    return onlyMine(r) && track('first_search_finished', tenantId, { job_id: jobId, count: leads, needs_review: needsReview }, d)
  } catch { return false }
}
