// Enrichment stage: after the verified/review rows are written (the job row is 'done' so the leads exist), dazl still runs the contact
// crawl, intent signals, people search and the buyer-fit gate. Until they finish, clients must not be told the scan is done: the status
// route and history report 'enriching' (see effectiveStatus). The stored status never changes, so retries, slots and queue completion
// are untouched; only these two timestamps record the stage.
import type Database from 'better-sqlite3'

// A crashed process cannot clear the flag. After this long without an end mark the stage is reported as interrupted (not enriching),
// so the page never waits forever. Well above the post-finish budget (90 s default) plus people search and buyer-fit.
export const ENRICH_STALE_S = 10 * 60

export interface EnrichFields { status: string; enrich_started_at?: number | null; enrich_finished_at?: number | null }
export type EnrichState = 'none' | 'running' | 'finished' | 'interrupted'

export function enrichState(job: EnrichFields, nowS = Math.floor(Date.now() / 1000)): EnrichState {
  if (job.status !== 'done' || !job.enrich_started_at) return 'none'
  if (job.enrich_finished_at) return 'finished'
  return nowS - job.enrich_started_at > ENRICH_STALE_S ? 'interrupted' : 'running'
}
// What to show a person: 'enriching' while the stage runs, otherwise the stored status.
export const effectiveStatus = (job: EnrichFields, nowS?: number): string => enrichState(job, nowS) === 'running' ? 'enriching' : job.status

// Both writes are conditional on this attempt still owning a finished row, like every other post-finish effect.
export function beginEnrichment(db: Database.Database, jobId: string, attempt: number): void {
  try { db.prepare("UPDATE scan_jobs SET enrich_started_at = CAST(strftime('%s','now') AS INTEGER), enrich_finished_at = NULL WHERE id = ? AND status = 'done' AND attempts = ?").run(jobId, attempt) } catch { /* older schema: the stage is simply not reported */ }
}
export function endEnrichment(db: Database.Database, jobId: string, attempt: number): void {
  try { db.prepare("UPDATE scan_jobs SET enrich_finished_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ? AND status = 'done' AND attempts = ? AND enrich_started_at IS NOT NULL AND enrich_finished_at IS NULL").run(jobId, attempt) } catch { /* see above */ }
}
