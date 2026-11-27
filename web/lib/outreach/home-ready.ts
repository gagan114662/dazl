// #1040 acceptance 1: Home's "Ready leads" tile - leads found in the last 30 days that are READY by the rule Home's journey
// and the first-run preview already use ("Leads ready", lib/journey.ts previewSplit / heldReason): every hold clear. Each lead
// gets exactly the hold fields GET /api/leads gives it (the same helpers, same arguments): the gate verdict, the time-window
// and currentness holds, the timing-adjusted intent and its enrichments. The checked list also receives the winning ready lead’s summary.
// A company found again by a later scan (seen_before, hidden on Leads by default) or by two scans in the window counts once
// (same domain or same normalised name), and it is ready when any of its leads is;
// test-fixture leads never count. The WHOLE window is judged, newest scan first, up to READY_LEADS_MAX leads per load;
// when that limit (or the store's per-scan read limit) cuts the count, the answer says so (capped) and counts only the
// scans it judged completely, so the page can say "first N leads checked" and "N or more" instead of a wrong total.
// On the scan store's synchronous handle, like GET /api/leads whose helpers it reuses (lib/db/pg-port-status.ts lists it).
import type Database from 'better-sqlite3'
import { getScanDb } from '@/lib/scan/service'
import { getJob, listLeads } from '@/lib/scan/store'
import { enrichmentsForLeads } from '@/lib/connectors/store'
import { leadHoldReason, timingOptsFor } from '@/lib/outreach/lead-hold'
import { countedOnHome, type PreviewLead } from '@/lib/journey'
import { companyKey } from '@/lib/scan/evidence'
import { RESULTS_WINDOW_DAYS } from '@/lib/outreach/home-results'
import { companyFirstShown, gateHoldReason, heldByChecksOf } from '@/lib/outreach/campaigns'
import { discoverContact, emailOnCompanySite, isDiscoverLead } from '@/lib/discover/card'
import { leadPerson } from '@/lib/people/lead-person'
import { identityOf } from '@/lib/scan/opportunity'
import { publishedEmail } from '@/lib/outreach/published-email'
import { leadContactContext, contactPurposeRestricted } from '@/lib/outreach/contact-purpose-db'
import { isSuppressed, recipientAllowed } from '@/lib/outreach/service'
import { shownIcp } from '@/lib/scan/carry-exclusions'
import { eventDayVerified } from '@/lib/scan/scoreboard'

export const READY_LEADS_MAX = 600    // leads judged per Home load (each costs a few indexed reads; batching them is #1181)
export const SCAN_READ_MAX = 500      // listLeads' own ceiling per scan

// companies: every company judged, in the order met, with its verdict - what the breakdown lines and the tile open
// (/app/leads/checked lists exactly these rows, so a line's number is the number of rows its link shows).
export interface ReadyCompany { lead_id: string; company: string; job_id: string; ready: boolean; reason: string; details?: ReadyLeadDetails }
interface ReadyLeadDetails {
  signal: string | null
  event_date: string | null
  day_verified: boolean
  contact_name: string | null
  contact_title: string | null
  email: string | null
  // #1833: the address exists but its recorded deliverability verdict is rejected / no_mx — the row says so
  // instead of showing the address as usable (approval and drafting already refuse it).
  email_undeliverable?: boolean
}

// The recorded deliverability format is lib/outreach/contact-route.ts's: a lead_enrichments row of kind
// 'deliverability', value '<email>|<verdict>' (a '@<domain>' row speaks for the domain's verdicts only). The latest
// applicable check wins; only 'rejected' and 'no_mx' mean the address cannot receive email.
const DELIVERABILITY_VERDICTS = ['no_mx', 'mx_found', 'catch_all', 'accepted', 'rejected']
const DOMAIN_VERDICTS = new Set(['no_mx', 'mx_found', 'catch_all'])
function deliverabilityRefused(rows: { kind: string; value: string; retrieved_at?: number | null }[], email: string): boolean {
  const e = email.toLowerCase(), domain = e.split('@')[1] ?? ''
  const latest = rows.filter(r => r.kind === 'deliverability')
    .map(r => { const [addr, verdict] = (r.value ?? '').toLowerCase().split('|'); return { addr, verdict, at: r.retrieved_at ?? 0 } })
    .filter(r => DELIVERABILITY_VERDICTS.includes(r.verdict) && (r.addr === e || (r.addr === `@${domain}` && DOMAIN_VERDICTS.has(r.verdict))))
    .sort((a, b) => b.at - a.at)[0]
  return latest?.verdict === 'rejected' || latest?.verdict === 'no_mx'
}

function buyerRolesOf(raw: string | null): string {
  try {
    const profile = shownIcp(raw) as { who?: unknown } | null
    return Array.isArray(profile?.who) ? profile.who.filter(role => typeof role === 'string').join('; ') : ''
  } catch { return '' }
}

function detailsOf(
  db: Database.Database, tenantId: string,
  lead: PreviewLead & { name?: string | null; source_kind?: string | null },
  buyerRoles: string, at: Date,
): ReadyLeadDetails {
  const rows = lead.enrichments ?? []
  const discover = isDiscoverLead(lead)
  const contact = discoverContact(lead)
  const person = discover ? contact?.person : leadPerson(rows, buyerRoles, at.getTime(), identityOf(lead, rows))
  let email: string | null = null
  let emailUndeliverable = false
  try {
    const published = contact?.email
    const address = discover
      ? published && emailOnCompanySite(published.address, published.source, lead.company_domain) ? published.address : null
      : publishedEmail({ ...lead, contact_context: leadContactContext(db, tenantId, lead.id) })
    if (address && deliverabilityRefused(rows, address)) emailUndeliverable = true   // #1833: recorded rejected / no_mx
    else if (address && recipientAllowed(db, tenantId, address) && !isSuppressed(db, tenantId, address)
      && !contactPurposeRestricted(db, tenantId, lead.id, address)) email = address
  } catch { /* Keep the ready details available if the address cannot be checked. */ }
  return {
    signal: lead.signal || null,
    event_date: lead.event_date,
    day_verified: eventDayVerified(lead, { now: at }),
    contact_name: person?.name ?? null,
    contact_title: person?.title || null,
    email,
    ...(emailUndeliverable ? { email_undeliverable: true } : {}),
  }
}
// held: why the other judged companies are not ready (lib/journey.ts heldReason's own words), largest first; job_id = the
// one scan holding them all, or null when they are in several (scans says how many). judged = ready + every held count.
// capped: a limit cut the count, so ready and held are lower bounds; leads_checked says how many leads were judged, and
// scans_checked counts only scans judged completely.
export interface HomeReady {
  window_days: number; ready: number; judged: number; scans_checked: number; scans_in_window: number
  capped: boolean; leads_checked: number; leads_in_window: number
  scans: { job_id: string; ready: number }[]
  held: { reason: string; count: number; job_id: string | null; scans: number }[]
  companies: ReadyCompany[]
}

export async function homeReady(tenantId: string, now: number = Math.floor(Date.now() / 1000), limits: { maxLeads?: number; perScan?: number } = {}): Promise<HomeReady> {
  const maxLeads = limits.maxLeads ?? READY_LEADS_MAX, perScan = Math.min(limits.perScan ?? SCAN_READ_MAX, SCAN_READ_MAX)
  const since = now - RESULTS_WINDOW_DAYS * 86400, at = new Date(now * 1000)
  const db = getScanDb()
  // The tenant's own scans (never test-only runs) holding leads the tile can judge - found in the window, shown on Leads
  // (not a poor fit; #1620: a new-engine lead whatever its fit, as every other page counts it), not rejected, not a fixture, not seen before - by their newest such lead, with how many each holds.
  const jobs = db.prepare(`SELECT j.id, j.run_budget, j.status, j.enrich_started_at, j.enrich_finished_at, MAX(l.created_at) AS last, COUNT(*) AS n FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND l.created_at >= ? AND NOT (j.industry = 'test only' AND j.location = 'test only')
      AND (l.fit IS NULL OR l.fit > 1 OR l.source_kind = 'discover') AND l.quarantined_at IS NULL AND COALESCE(l.source_kind, '') <> 'test' AND COALESCE(l.seen_before, 0) = 0
    GROUP BY j.id ORDER BY last DESC, j.id DESC`).all(tenantId, since) as { id: string; n: number; run_budget: string | null; status: string; enrich_started_at: number | null; enrich_finished_at: number | null }[]
  // #1062: a company-first scan shows only the leads its final checks let through (companyFirstResults, the run page's own gate), judged from
  // this one read of the scans; the rest are held by those checks (or by checks still running), never "needs your review". Fails closed.
  const shown = await companyFirstShown(db, tenantId, jobs, at)
  // One verdict per COMPANY, matched the way "seen before" matches (lib/scan/store.ts markSeenBefore): the same domain, or
  // the same normalised name. READY wins: a company is ready when any of its judged leads is ready (that lead shows ready
  // on its scan's Leads page); otherwise it is held for the reason of the first lead met (newest scan first).
  type Verdict = ReadyCompany
  const companies: Verdict[] = [], byKey = new Map<string, Verdict>()
  let checked = 0, judgedLeads = 0, capped = false
  scan: for (const j of jobs) {
    const { id, n } = j, byChecks = heldByChecksOf(j, shown)
    const job = getJob(db, tenantId, id) as { id: string; query: string | null; icp: string | null } | undefined
    if (!job) continue
    const timingOpts = timingOptsFor({ ...job, run_budget: j.run_budget })
    const buyerRoles = buyerRolesOf(job.icp)
    const leads = (listLeads(db, tenantId, id, perScan, true) as (PreviewLead & { created_at: number; seen_before?: number | null; source_kind?: string | null; name?: string | null; company_domain: string | null; company: string; quarantined_at?: unknown })[])
      .filter(l => countedOnHome(l) && Number(l.created_at) >= since && !l.seen_before && l.source_kind !== 'test' && !l.quarantined_at)   // rejected leads are not judged
    const enr = enrichmentsForLeads(db, tenantId, leads.map(l => l.id))
    let whole = leads.length >= Number(n)   // false: the per-scan read limit left judgeable leads of this scan unread
    for (const l of leads) {
      const keys = [l.company_domain ? `d:${l.company_domain.trim().toLowerCase()}` : '', l.company ? `n:${companyKey(l.company)}` : ''].filter(k => k.length > 2)
      if (!keys.length) keys.push(`id:${l.id}`)
      let v = keys.map(k => byKey.get(k)).find(Boolean)
      if (v?.ready) { for (const k of keys) byKey.set(k, v); continue }   // already ready: nothing more to compute for this company
      if (judgedLeads >= maxLeads) { capped = true; whole = false; break }
      judgedLeads++
      // the hold fields exactly as GET /api/leads computes them, for this lead only
      const why = byChecks(l.id) ? gateHoldReason(j, shown) : leadHoldReason(db, tenantId, l as never, enr[l.id] ?? [], timingOpts, at)   // lib/outreach/lead-hold.ts: the one rule
      if (!v) { v = { lead_id: l.id, company: l.company || 'Unnamed company', job_id: id, ready: !why, reason: why ?? '' }; companies.push(v) }
      else if (!why) { v.ready = true; v.reason = ''; v.job_id = id; v.lead_id = l.id; v.company = l.company || v.company }   // held in a newer scan, ready in this one: ready wins
      if (!why) v.details = detailsOf(db, tenantId, { ...l, enrichments: enr[l.id] ?? [] }, buyerRoles, at)
      for (const k of keys) byKey.set(k, v)
    }
    if (whole) checked++; else capped = true
    if (judgedLeads >= maxLeads && capped) break scan
  }
  const scans = new Map<string, number>(), held = new Map<string, { count: number; jobs: Set<string> }>()
  for (const v of companies) {
    if (v.ready) { scans.set(v.job_id, (scans.get(v.job_id) ?? 0) + 1); continue }
    const h = held.get(v.reason) ?? { count: 0, jobs: new Set<string>() }
    h.count++; h.jobs.add(v.job_id); held.set(v.reason, h)
  }
  const heldList = [...held].map(([reason, h]) => ({ reason, count: h.count, job_id: h.jobs.size === 1 ? [...h.jobs][0] : null, scans: h.jobs.size }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
  const ready = companies.filter(v => v.ready).length
  return { window_days: RESULTS_WINDOW_DAYS, ready, judged: companies.length, scans_checked: checked, scans_in_window: jobs.length, capped,
    leads_checked: judgedLeads, leads_in_window: jobs.reduce((a, j) => a + Number(j.n), 0),
    scans: [...scans].map(([job_id, n]) => ({ job_id, ready: n })), held: heldList, companies }
}
