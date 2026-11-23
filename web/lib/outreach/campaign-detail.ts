import type { Db } from '../db/client.ts'
import { recordedJobCostUsd } from '../scan/job-cost.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { companyFirstResults, type CompanyFirstResultCounts } from '../scan/company-first-results.ts'
import { hasSentHistory } from './campaign-view.ts'
import { windowHeld } from './currentness.ts'
import { requiredGateHeldForJob } from '../scan/held-state.ts'
import { buyerUnreachable } from '../people/buyer-reach.ts'
import type { DiscoverState } from '../discover/card.ts'
import { discoverStatesForDb } from '../discover/state-db.ts'

// Everything the one-campaign page shows, for ONE scan of ONE tenant, read in full: the job, every lead of the scan and
// every email drafted from those leads. Plain SELECTs only - unlike the scan status read (getJob reaps stale jobs) and
// the Outreach list (newest 200 across the account), nothing here writes or truncates, so an old campaign's history is
// complete. Returns null for a scan that does not exist or is not this tenant's (the route answers both as 404).
export interface CampaignDetail {
  company_first_counts?: CompanyFirstResultCounts | null
  job: { id: string; query: string | null; status: string; error: string | null; funded_by: 'trial' | null; spend_usd: number | string | null; created_at: number; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; enrich_started_at: number | null; enrich_finished_at: number | null }
  leads: { id: string; company: string | null; name: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; quarantined_at: number | null; quarantine_reason: string | null
    // Held by the search's time window (no usable date, or older than it): the draft gate's own verdict (currentness.ts windowHeld), so the
    // page can tell a research-only lead from one a review can release (#683). Computed here; the job's saved profile is not returned.
    window_held: boolean
    company_first_display_only?: true
    // The reason a lead was confirmed OUT of, when it was held for something a check cannot resolve (someone else's customer, a
    // different place, a closed opening): confirming it does not change that (#683, the same rule as campaigns.ts heldResearch).
    human_confirmed_from: string | null
    // Held by a REQUIRED check that has not passed (the sales-hiring proof, lib/scan/held-state.ts requiredGateHeld) - also when the
    // row reads machine-verified with no review_reason (the DEFAULT-DENY branch). The draft guard's own verdict, so the page never
    // calls a lead the draft gate refuses "Source-checked, not drafted" (#1062).
    gate_held: boolean
    // No review can give the lead its buyer (#1037, lib/people/buyer-reach.ts): a review-list lead is then research, as on Home.
    buyer_unreachable: boolean
    // A lead from the new engine: its ONE state (lib/discover/card.ts discoverState), which the page counts and labels it by. null for any other lead.
    discover_state: DiscoverState | null }[]
  messages: { id: string; lead_id: string; to_email: string; subject: string; status: string; created_at: number; sent_at: number | null }[]
}

// On the Db layer (SQLite or Postgres). Leads list in insertion order and messages newest first with insertion order
// breaking same-second ties, as the raw queries did with rowid (insert_seq: lib/db/insertion-order.ts).
export async function campaignDetail(db: Db, tenantId: string, jobId: string): Promise<CampaignDetail | null> {
  const job = await db.get<CampaignDetail['job'] & { spend_run_usd?: number | string | null; spend_cap_usd?: number | string | null }>("SELECT id, query, status, error, CASE WHEN funded_by = 'trial' THEN 'trial' END AS funded_by, spend_reserved_usd AS spend_run_usd, spend_cap_reserved_usd AS spend_cap_usd, created_at, candidates, verified, needs_review, dropped, enrich_started_at, enrich_finished_at FROM scan_jobs WHERE id = ? AND user_id = ?", [jobId, tenantId])
  if (!job) return null
  const w = await db.get<{ icp: string | null; run_budget: string | null }>('SELECT icp, run_budget FROM scan_jobs WHERE id = ? AND user_id = ?', [job.id, tenantId])
  const rows = await db.all<Omit<CampaignDetail['leads'][number], 'window_held' | 'gate_held' | 'buyer_unreachable' | 'discover_state'> & { event_date: string | null; contact: string | null }>(`SELECT id, company, name, contact, evidence_excerpt, confidence, human_confirmed_at, review_reason, human_confirmed_from, quarantined_at, quarantine_reason, event_date
    FROM leads WHERE scan_job_id = ? ORDER BY insert_seq`, [job.id])
  const now = new Date()
  // The draft guard's own verdict (lib/scan/held-state.ts), read for the whole scan on this Db (#1062).
  const gateHeld = await requiredGateHeldForJob(db, tenantId, job.id)
  const noBuyer = await buyerUnreachable(db, tenantId, [job.id], rows.filter(r => r.review_reason))
  const dStates = (await discoverStatesForDb(db, tenantId, [job.id])).get(job.id)
  const marked = hasCompanyFirstBudget(w?.run_budget)
  const proof = marked ? await companyFirstResults(db, tenantId, job.id, now) : null
  const displayed = marked ? rows.filter(l => proof?.visibleIds.has(l.id)) : rows
  // the lead's contact is read for the buyer check only; the page's lead shape does not carry it
  const leads = displayed.map(row => {
    const { event_date, contact, ...l } = row; void contact
    return { ...l, buyer_unreachable: noBuyer.has(l.id), window_held: windowHeld({ event_date, icp: w?.icp ?? null, query: job.query, run_budget: w?.run_budget ?? null }, now), gate_held: gateHeld.has(l.id), discover_state: dStates?.get(l.id) ?? null,
      ...(proof && !proof.readyIds.has(l.id) ? { company_first_display_only: true as const } : {}) }
  })
  // Newest first, so the first message per lead is its latest.
  const messages = await db.all<CampaignDetail['messages'][number]>(`SELECT m.id, m.lead_id, m.to_email, m.subject, m.status, m.created_at, m.sent_at
    FROM outreach_messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.tenant_id = ? AND l.scan_job_id = ? ORDER BY m.created_at DESC, m.insert_seq DESC`, [tenantId, job.id])
  // The row was read: an empty spend column means no paid call was recorded (0), the same as the status read and the history list.
  const { spend_run_usd, spend_cap_usd, ...row } = job
  // the job's one recorded cost (job-cost.ts, #1517): never the two guards' columns added
  return { job: { ...row, spend_usd: recordedJobCostUsd(spend_run_usd, spend_cap_usd) }, leads, messages: marked ? messages.filter(m => hasSentHistory(m) || proof?.readyIds.has(m.lead_id)) : messages,
    ...(marked ? { company_first_counts: proof?.counts ?? null } : {}) }
}
