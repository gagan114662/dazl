import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import type { CompanyFirstPublishedDisplayRow } from '../people/company-first-published-display.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { currentnessHeld } from '../outreach/currentness.ts'
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
  counts: CompanyFirstResultCounts
  visibleIds: ReadonlySet<string>
  readyIds: ReadonlySet<string>
  displayProof: Readonly<Record<string, CompanyFirstPublishedDisplayRow>>
}>

type ResultJob = { id: string; run_budget: string | null; status: string; attempts: number; enrich_finished_at: number | null;
  candidates: number | null; dropped: number | null; stored: number }

export const companyFirstResults = (db: Db, tenantId: string, jobId: string, now = new Date()): Promise<CompanyFirstResults | null> =>
  db.companyFirstResults?.(tenantId, jobId, now) ?? Promise.resolve(null)

// Invoked only by the SQLite implementation of the Db that is already open
// for this request. Ready rows retain the existing contact/currentness gate.
// Verified display-only rows are reviewable, but never send-ready.
export async function readBoundCompanyFirstResults(raw: Database.Database, db: Db, tenantId: string, jobId: string, now: Date): Promise<CompanyFirstResults | null> {
  const read = () => db.get<ResultJob>(`SELECT id,run_budget,status,attempts,enrich_finished_at,candidates,dropped,
    (SELECT count(*) FROM leads l WHERE l.scan_job_id=j.id) AS stored
    FROM scan_jobs j WHERE id=? AND user_id=?`, [jobId, tenantId])
  const job = await read()
  if (!job || !hasCompanyFirstBudget(job.run_budget)) return null
  const ids = new Set<string>(), ready = new Set<string>()
  let displayProof: Readonly<Record<string, CompanyFirstPublishedDisplayRow>> = {}
  if (job.status === 'done' && job.enrich_finished_at != null) {
    const rows = listLeads(raw, tenantId, jobId, 200, false) as { id: string }[]
    displayProof = await verifiedCompanyFirstDisplay(raw, tenantId, jobId, rows.map(l => l.id), now)
    // Do not combine proof from a different attempt or an in-progress rescan.
    const latest = await read()
    if (!latest || latest.attempts !== job.attempts || latest.status !== job.status || latest.enrich_finished_at !== job.enrich_finished_at ||
        latest.run_budget !== job.run_budget || latest.stored !== job.stored) return null
    for (const row of rows) {
      if (!currentnessHeld(raw, tenantId, row.id, now)) ready.add(row.id)
      if (ready.has(row.id) || Object.hasOwn(displayProof, row.id)) ids.add(row.id)
    }
  }
  return { counts: { candidates: job.candidates, ready: ready.size, reviewable: ids.size, held: Math.max(0, job.stored - ids.size), dropped: job.dropped },
    visibleIds: ids, readyIds: ready, displayProof }
}
