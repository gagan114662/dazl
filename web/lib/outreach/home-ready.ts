// #1040 acceptance 1: Home's "Ready leads" tile - leads found in the last 30 days that are READY by the rule Home's journey
// and the first-run preview already use ("Leads ready", lib/journey.ts previewSplit / heldReason): every hold clear. Each lead
// gets exactly the hold fields GET /api/leads gives it (the same helpers, same arguments): the gate verdict, the time-window
// and currentness holds, the timing-adjusted intent and its enrichments. Nothing else of the Leads view is built (count only).
// A company found again by a later scan (seen_before, hidden on Leads by default) or by two scans in the window counts once
// (same domain or same normalised name), and it is ready when any of its leads is;
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
import { companyKey } from '@/lib/scan/evidence'
import { RESULTS_WINDOW_DAYS } from '@/lib/outreach/home-results'

export const READY_SCANS_MAX = 10
// scans: the scans holding the counted leads (a company found by two scans counts under the newer one), newest first, so the
// tile can open the scan its number is in instead of one that shows fewer rows.
// held: why the other judged leads are not ready (lib/journey.ts heldReason's own words), one company once, largest first;
// job_id = the one scan holding them all, or null when they are in several (scans says how many). judged = ready + every
// held count: the companies found in the window that the tile looked at (rejected leads are not judged at all).
export interface HomeReady {
  window_days: number; ready: number; judged: number; scans_checked: number; scans_in_window: number
  capped: boolean   // true: the per-load lead limit was reached before every scan was judged
  scans: { job_id: string; ready: number }[]
  held: { reason: string; count: number; job_id: string | null; scans: number }[]
}

export const READY_LEADS_MAX = 600   // leads judged per Home load, across the scans checked (each costs a few indexed reads)

export async function homeReady(tenantId: string, now: number = Math.floor(Date.now() / 1000)): Promise<HomeReady> {
  const since = now - RESULTS_WINDOW_DAYS * 86400, at = new Date(now * 1000)
  const db = getScanDb()
  // The tenant's own scans (never test-only runs) holding leads the tile can judge - found in the window, shown on Leads
  // (not a poor fit), not rejected, not a fixture, not seen before - by their newest such lead: a scan with only hidden or
  // rejected leads never takes one of the slots, and a watch that found leads today ranks by those.
  const jobs = db.prepare(`SELECT j.id, MAX(l.created_at) AS last FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND l.created_at >= ? AND NOT (j.industry = 'test only' AND j.location = 'test only')
      AND (l.fit IS NULL OR l.fit > 1) AND l.quarantined_at IS NULL AND COALESCE(l.source_kind, '') <> 'test' AND COALESCE(l.seen_before, 0) = 0
    GROUP BY j.id ORDER BY last DESC, j.id DESC`).all(tenantId, since) as { id: string }[]
  // One verdict per COMPANY, matched the way "seen before" matches (lib/scan/store.ts markSeenBefore): the same domain, or
  // the same normalised name. READY wins: a company is ready when any of its judged leads is ready (that lead shows ready
  // on its scan's Leads page); otherwise it is held for the reason of the first lead met (newest scan first).
  type Verdict = { ready: boolean; reason: string; job: string }
  const companies: Verdict[] = [], byKey = new Map<string, Verdict>()
  let checked = 0, judgedLeads = 0, capped = false
  scan: for (const { id } of jobs.slice(0, READY_SCANS_MAX)) {
    const job = getJob(db, tenantId, id) as { id: string; query: string | null; icp: string | null } | undefined
    if (!job) continue
    const windowDays = jobWindowDays(job as never)
    const timingOpts = { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
    const leads = (listLeads(db, tenantId, id, 200, false) as (PreviewLead & { created_at: number; seen_before?: number | null; source_kind?: string | null; company_domain?: string | null; company: string; quarantined_at?: unknown })[])
      .filter(l => Number(l.created_at) >= since && !l.seen_before && l.source_kind !== 'test' && !l.quarantined_at)   // rejected leads are not judged
    const enr = enrichmentsForLeads(db, tenantId, leads.map(l => l.id))
    checked++
    for (const l of leads) {
      const keys = [l.company_domain ? `d:${l.company_domain.trim().toLowerCase()}` : '', l.company ? `n:${companyKey(l.company)}` : ''].filter(k => k.length > 2)
      if (!keys.length) keys.push(`id:${l.id}`)
      let v = keys.map(k => byKey.get(k)).find(Boolean)
      if (v?.ready) { for (const k of keys) byKey.set(k, v); continue }   // already ready: nothing more to compute for this company
      if (judgedLeads >= READY_LEADS_MAX) { capped = true; break scan }
      judgedLeads++
      // the hold fields exactly as GET /api/leads computes them, for this lead only
      const row = { ...l, intent: surfaceStoredIntent(l as never, timingOpts).intent, enrichments: enr[l.id] ?? [],
        window_held: leadWindowHeld(db, tenantId, l.id, at), currentness_held: currentnessHeld(db, tenantId, l.id, at), gate_held: requiredGateHeld(db, tenantId, l.id) !== null }
      const why = heldReason(row as never)
      if (!v) { v = { ready: !why, reason: why ?? '', job: id }; companies.push(v) }
      else if (!why) { v.ready = true; v.reason = ''; v.job = id }   // held in a newer scan, ready in this one: ready wins
      for (const k of keys) byKey.set(k, v)
    }
  }
  const scans = new Map<string, number>(), held = new Map<string, { count: number; jobs: Set<string> }>()
  for (const v of companies) {
    if (v.ready) { scans.set(v.job, (scans.get(v.job) ?? 0) + 1); continue }
    const h = held.get(v.reason) ?? { count: 0, jobs: new Set<string>() }
    h.count++; h.jobs.add(v.job); held.set(v.reason, h)
  }
  const heldList = [...held].map(([reason, h]) => ({ reason, count: h.count, job_id: h.jobs.size === 1 ? [...h.jobs][0] : null, scans: h.jobs.size }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  const ready = companies.filter(v => v.ready).length
  return { window_days: RESULTS_WINDOW_DAYS, ready, judged: companies.length, scans_checked: checked, scans_in_window: jobs.length, capped,
    scans: [...scans].map(([job_id, n]) => ({ job_id, ready: n })), held: heldList }
}
