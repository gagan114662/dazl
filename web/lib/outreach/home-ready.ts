// #1040 acceptance 1: Home's "Ready leads" tile - leads found in the last 30 days that the Leads page shows as READY (every
// hold clear: the same per-lead view as GET /api/leads, lib/scan/leads-view-server.ts, split by the same rule as the Leads
// page and Home's journey, lib/journey.ts previewSplit). Counted over the newest scans with leads in the window, bounded so a
// Home load never walks a workspace's whole history; when there are more, the answer says how many scans it checked.
// Server only (the per-lead holds read the store).
import { getScanDb } from '@/lib/scan/service'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { leadsViewForJob } from '@/lib/scan/leads-view-server'
import { previewSplit, type PreviewLead } from '@/lib/journey'
import { RESULTS_WINDOW_DAYS } from '@/lib/outreach/home-results'

export const READY_SCANS_MAX = 10
export interface HomeReady { window_days: number; ready: number; scans_checked: number; scans_in_window: number }

export async function homeReady(tenantId: string, now: number = Math.floor(Date.now() / 1000)): Promise<HomeReady> {
  const since = now - RESULTS_WINDOW_DAYS * 86400
  const scan = getScanDb()
  // the tenant's own scans (never test-only runs) with leads found in the window, newest first (indexed: leads_job_created)
  const jobs = scan.prepare(`SELECT j.id FROM scan_jobs j WHERE j.user_id = ? AND NOT (j.industry = 'test only' AND j.location = 'test only')
      AND EXISTS (SELECT 1 FROM leads l WHERE l.scan_job_id = j.id AND l.created_at >= ?)
    ORDER BY j.created_at DESC, j.insert_seq DESC`).all(tenantId, since) as { id: string }[]
  const db = sqliteLeadsRead(scan)
  let ready = 0, checked = 0
  for (const { id } of jobs.slice(0, READY_SCANS_MAX)) {
    const job = await db.getJob(tenantId, id)
    if (!job) continue
    const view = await leadsViewForJob(tenantId, job, false)
    const inWindow = (view.leads as unknown as (PreviewLead & { created_at: number })[]).filter(l => Number(l.created_at) >= since)
    ready += previewSplit(inWindow).opportunities.length
    checked++
  }
  return { window_days: RESULTS_WINDOW_DAYS, ready, scans_checked: checked, scans_in_window: jobs.length }
}
