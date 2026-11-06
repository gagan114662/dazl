import { asDb, type DbLike } from '../db/client.ts'

// Source-run quality metrics: which collectors actually produce leads that survive the
// pipeline, carry an ICP grade, and draw replies. Built only on recorded provenance
// (scan_source_runs + lead_sources, #121) - old scans are not backfilled, unknown
// counters stay NULL (rendered "-"), never zero.
//
// Honesty rules baked in:
// - A lead found by several collectors counts toward EACH (lead_sources credits overlap
//   by design), so per-collector rows never sum to a total - the UI says so.
// - candidates/verified can be unobserved (NULL) for a run; if ANY contributing run is
//   unknown, the aggregate is unknown, not a silent undercount.
// - A reply is associated with the lead's source, not caused by it. Replies keep
//   arriving, so leads younger than REPLY_WINDOW_S are reported separately.
// - "Buyer" is the account ICP grade (leads.fit), never the reply-thread verdict -
//   different entities, no join between them.

export const REPLY_WINDOW_S = 7 * 86400
export const STRONG_FIT = 4 // chosen threshold, labelled in the UI

export interface SourceMetricRow {
  collector: string
  jobs: number
  candidates: number | null
  verified: number | null
  inserted: number
  leads: number
  icp_graded: number
  strong_fit: number
  outreach_started: number
  replied: number
  recent_leads: number
}

export interface SourceMetrics {
  rows: SourceMetricRow[]
  reply_window_days: number
  strong_fit_threshold: number
}

// On the Db layer (#354): the route reads it on SQLite or Postgres; a raw better-sqlite3 handle is wrapped on the same
// connection. Engine-neutral SQL: 'any run unknown' is MAX over a 0/1 CASE (Postgres has no MAX(boolean)), and each SUM
// is cast back to BIGINT (Postgres sums BIGINT as NUMERIC, which the driver returns as a string).
export async function sourceMetrics(d: DbLike, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<SourceMetrics> {
  const db = asDb(d)
  const runs = await db.all<{ collector: string; jobs: number; candidates: number | null; candidates_unknown: number; verified: number | null; verified_unknown: number; inserted: number | null }>(`
    SELECT r.collector AS collector,
           COUNT(DISTINCT r.job_id) AS jobs,
           CAST(SUM(r.candidate_count) AS BIGINT) AS candidates,
           MAX(CASE WHEN r.candidate_count IS NULL THEN 1 ELSE 0 END) AS candidates_unknown,
           CAST(SUM(r.verified_count) AS BIGINT) AS verified,
           MAX(CASE WHEN r.verified_count IS NULL THEN 1 ELSE 0 END) AS verified_unknown,
           CAST(SUM(r.inserted_count) AS BIGINT) AS inserted
    FROM scan_source_runs r JOIN scan_jobs j ON j.id = r.job_id
    WHERE j.user_id = ? GROUP BY r.collector
  `, [tenantId])

  const cutoff = now - REPLY_WINDOW_S
  const outcomes = await db.all<{ collector: string; leads: number; icp_graded: number; strong_fit: number; recent_leads: number; outreach_started: number; replied: number }>(`
    SELECT s.collector AS collector,
           COUNT(DISTINCT s.lead_id) AS leads,
           COUNT(DISTINCT CASE WHEN l.fit IS NOT NULL THEN s.lead_id END) AS icp_graded,
           COUNT(DISTINCT CASE WHEN l.fit >= ? THEN s.lead_id END) AS strong_fit,
           COUNT(DISTINCT CASE WHEN l.created_at > ? THEN s.lead_id END) AS recent_leads,
           COUNT(DISTINCT q.lead_id) AS outreach_started,
           COUNT(DISTINCT CASE WHEN q.status = 'replied' THEN q.lead_id END) AS replied
    FROM lead_sources s
    JOIN leads l ON l.id = s.lead_id
    JOIN scan_jobs j ON j.id = l.scan_job_id
    LEFT JOIN sequences q ON q.lead_id = s.lead_id AND q.tenant_id = j.user_id
    WHERE j.user_id = ? GROUP BY s.collector
  `, [STRONG_FIT, cutoff, tenantId])

  const byCollector = new Map<string, SourceMetricRow>()
  for (const r of runs) {
    byCollector.set(r.collector, {
      collector: r.collector, jobs: r.jobs,
      candidates: r.candidates_unknown ? null : (r.candidates ?? 0),
      verified: r.verified_unknown ? null : (r.verified ?? 0),
      inserted: r.inserted ?? 0,
      leads: 0, icp_graded: 0, strong_fit: 0, outreach_started: 0, replied: 0, recent_leads: 0,
    })
  }
  for (const o of outcomes) {
    const row = byCollector.get(o.collector) ?? {
      collector: o.collector, jobs: 0, candidates: null, verified: null, inserted: 0,
      leads: 0, icp_graded: 0, strong_fit: 0, outreach_started: 0, replied: 0, recent_leads: 0,
    }
    row.leads = o.leads; row.icp_graded = o.icp_graded; row.strong_fit = o.strong_fit
    row.outreach_started = o.outreach_started; row.replied = o.replied; row.recent_leads = o.recent_leads
    byCollector.set(o.collector, row)
  }
  // Most productive first: replies, then credited leads, then recorded volume.
  const rows = [...byCollector.values()].sort((a, b) => b.replied - a.replied || b.leads - a.leads || (b.candidates ?? 0) - (a.candidates ?? 0) || a.collector.localeCompare(b.collector))
  return { rows, reply_window_days: REPLY_WINDOW_S / 86400, strong_fit_threshold: STRONG_FIT }
}
