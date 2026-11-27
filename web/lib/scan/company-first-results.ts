import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import type { CompanyFirstPublishedDisplayRow } from '../people/company-first-published-display.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { enrichmentsForLeads } from '../connectors/store.ts'
import { currentnessHeld } from '../outreach/currentness.ts'
import { leadHoldReason, timingOptsFor } from '../outreach/lead-hold.ts'
import { verifiedCompanyFirstDisplay } from './actionable.ts'
import { listLeads } from './store.ts'

export type CompanyFirstResultCounts = Readonly<{
  candidates: number | null
  ready: number
  reviewable: number
  held: number
  dropped: number | null
}>
export type CompanyFirstResults = Readonly<{
  // true only when visibility was computed: the job was done with its enrichment finished, and the re-read after the computation saw the
  // same attempt, status, end mark, budget and row count. A caller that needs "the final checks ran" reads THIS, never a separate read of the
  // job, so the two can never describe different enrichment attempts (#1062, Qodo on #1466).
  final: boolean
  counts: CompanyFirstResultCounts
  visibleIds: ReadonlySet<string>
  readyIds: ReadonlySet<string>
  displayProof: Readonly<Record<string, CompanyFirstPublishedDisplayRow>>
}>

type ResultJob = { id: string; query: string | null; icp: string | null; run_budget: string | null; status: string; attempts: number; enrich_finished_at: number | null;
  candidates: number | null; dropped: number | null; stored: number }

export const companyFirstResults = (db: Db, tenantId: string, jobId: string, now = new Date()): Promise<CompanyFirstResults | null> =>
  db.companyFirstResults?.(tenantId, jobId, now) ?? Promise.resolve(null)

// Invoked only by the SQLite implementation of the Db that is already open
// for this request. Visibility retains the final-check and display-proof gates.
// Ready uses the same lead hold verdict as Home.
export async function readBoundCompanyFirstResults(raw: Database.Database, db: Db, tenantId: string, jobId: string, now: Date): Promise<CompanyFirstResults | null> {
  const read = () => db.get<ResultJob>(`SELECT id,query,icp,run_budget,status,attempts,enrich_finished_at,candidates,dropped,
    (SELECT count(*) FROM leads l WHERE l.scan_job_id=j.id) AS stored
    FROM scan_jobs j WHERE id=? AND user_id=?`, [jobId, tenantId])
  const job = await read()
  if (!job || !hasCompanyFirstBudget(job.run_budget)) return null
  const ids = new Set<string>(), ready = new Set<string>()
  let displayProof: Readonly<Record<string, CompanyFirstPublishedDisplayRow>> = {}
  const final = job.status === 'done' && job.enrich_finished_at != null
  if (final) {
    const rows = listLeads(raw, tenantId, jobId, 200, false) as (Record<string, unknown> & { id: string })[]
    displayProof = await verifiedCompanyFirstDisplay(raw, tenantId, jobId, rows.map(l => l.id), now)
    // Do not combine proof from a different attempt or an in-progress rescan.
    const latest = await read()
    if (!latest || latest.attempts !== job.attempts || latest.status !== job.status || latest.enrich_finished_at !== job.enrich_finished_at ||
        latest.run_budget !== job.run_budget || latest.stored !== job.stored) return null
    const timing = timingOptsFor(job)
    const enrichments = enrichmentsForLeads(raw, tenantId, rows.map(row => row.id))
    for (const row of rows) {
      const canPassFinalChecks = !currentnessHeld(raw, tenantId, row.id, now)
      if (canPassFinalChecks || Object.hasOwn(displayProof, row.id)) ids.add(row.id)
      if (canPassFinalChecks && !leadHoldReason(raw, tenantId, row, enrichments[row.id] ?? [], timing, now)) ready.add(row.id)
    }
  }
  return { final, counts: { candidates: job.candidates, ready: ready.size, reviewable: ids.size, held: Math.max(0, job.stored - ids.size), dropped: job.dropped },
    visibleIds: ids, readyIds: ready, displayProof }
}
