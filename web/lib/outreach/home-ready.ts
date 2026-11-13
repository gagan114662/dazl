// #1040 acceptance 1: Home's "Ready leads" tile - leads found in the last 30 days that are READY by the rule Home's journey
// and the first-run preview already use ("Leads ready", lib/journey.ts previewSplit / heldReason): every hold clear. Each lead
// gets exactly the hold fields GET /api/leads gives it (the same helpers, same arguments): the gate verdict, the time-window
// and currentness holds, the timing-adjusted intent and its enrichments. Nothing else of the Leads view is built (count only).
// A company found again by a later scan (seen_before, hidden on Leads by default) or by two scans in the window counts once;
// test-fixture leads never count. Bounded: the 10 scans with the newest leads in the window, at most 200 leads each (the
// Leads page's own page size); the answer says how many scans it checked.
// On the scan store's synchronous handle, like GET /api/leads whose helpers it reuses (lib/db/pg-port-status.ts lists it).
import { getScanDb } from '@/lib/scan/service'
import { getJob, listLeads } from '@/lib/scan/store'
import { enrichmentsForLeads } from '@/lib/connectors/store'
import { currentnessHeld, leadWindowHeld } from '@/lib/outreach/currentness'
import { requiredGateHeld } from '@/lib/scan/held-state'
import { surfaceStoredIntent, TIMING_REQUESTED } from '@/lib/scan/scoreboard'
import { jobWindowDays } from '@/lib/scan/window'
import { heldReason, type PreviewLead } from '@/lib/journey'
import { RESULTS_WINDOW_DAYS } from '@/lib/outreach/home-results'

export const READY_SCANS_MAX = 10
// scans: the scans holding the counted leads (a company found by two scans counts under the newer one), newest first, so the
// tile can open the scan its number is in instead of one that shows fewer rows.
// held: why the other judged leads are not ready (lib/journey.ts heldReason's own words), one company once, largest first;
// job_id = the one scan holding them all, or null when they are in several (scans says how many). judged = ready + every
// held count: the companies found in the window that the tile looked at (rejected leads are not judged at all).
export interface HomeReady {
  window_days: number; ready: number; judged: number; scans_checked: number; scans_in_window: number
  scans: { job_id: string; ready: number }[]
  held: { reason: string; count: number; job_id: string | null; scans: number }[]
}

export async function homeReady(tenantId: string, now: number = Math.floor(Date.now() / 1000)): Promise<HomeReady> {
  const since = now - RESULTS_WINDOW_DAYS * 86400
  const db = getScanDb()
  // the tenant's own scans (never test-only runs) with leads found in the window, by their newest lead (a watch that found
  // leads today ranks by those, not by when it was created)
  const jobs = db.prepare(`SELECT j.id, MAX(l.created_at) AS last FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND l.created_at >= ? AND NOT (j.industry = 'test only' AND j.location = 'test only')
    GROUP BY j.id ORDER BY last DESC, j.id DESC`).all(tenantId, since) as { id: string }[]
  const counted = new Set<string>(), scans: { job_id: string; ready: number }[] = []
  const held = new Map<string, { count: number; jobs: Set<string> }>()
  let ready = 0
  let checked = 0
  for (const { id } of jobs.slice(0, READY_SCANS_MAX)) {
    const job = getJob(db, tenantId, id) as { id: string; query: string | null; icp: string | null } | undefined
    if (!job) continue
    const windowDays = jobWindowDays(job as never)
    const timingOpts = { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
    const leads = (listLeads(db, tenantId, id, 200, false) as (PreviewLead & { created_at: number; seen_before?: number | null; source_kind?: string | null; company_domain?: string | null; company: string })[])
      .filter(l => Number(l.created_at) >= since && !l.seen_before && l.source_kind !== 'test')
    const enr = enrichmentsForLeads(db, tenantId, leads.map(l => l.id))
    const rows = leads.map(l => ({ ...l, intent: surfaceStoredIntent(l as never, timingOpts).intent, enrichments: enr[l.id] ?? [],
      window_held: leadWindowHeld(db, tenantId, l.id), currentness_held: currentnessHeld(db, tenantId, l.id), gate_held: requiredGateHeld(db, tenantId, l.id) !== null }))
    let here = 0
    // one verdict per company, the first time it is met (newest scan first): ready, or the reason it is held
    for (const l of rows as unknown as (PreviewLead & { company: string; company_domain?: string | null; quarantined_at?: unknown })[]) {
      if (l.quarantined_at) continue   // rejected by the user: neither ready nor waiting on anything
      const k = (l.company_domain || l.company || '').trim().toLowerCase() || `id:${l.id}`
      if (counted.has(k)) continue
      counted.add(k)
      const why = heldReason(l)
      if (!why) { ready++; here++; continue }
      const h = held.get(why) ?? { count: 0, jobs: new Set<string>() }
      h.count++; h.jobs.add(id); held.set(why, h)
    }
    if (here > 0) scans.push({ job_id: id, ready: here })
    checked++
  }
  const heldList = [...held].map(([reason, h]) => ({ reason, count: h.count, job_id: h.jobs.size === 1 ? [...h.jobs][0] : null, scans: h.jobs.size }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  return { window_days: RESULTS_WINDOW_DAYS, ready, judged: counted.size, scans_checked: checked, scans_in_window: jobs.length, scans, held: heldList }
}
