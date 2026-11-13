// Held leads the pass may also search (after every ready lead, inside the same cap): the lead is held for its evidence, its
// date or a check that did not pass, and its company is still the named one. A person found for it is a labelled search
// result on a held row; it never makes the lead ready. Not searched: a hold that puts the company itself in doubt (a place
// that disagrees or is unconfirmed, someone else's customer, an owner's self-description, the tenant's own form signal) and
// a lead whose checks never ran (trial_budget_reached) and any reason not listed here (fail closed).
// Pure (no data layer): the Leads page uses the same rule to decide whether a held row shows a person line.
export const SEARCHABLE_HOLDS: readonly string[] = ['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required', 'outside_window', 'outside_window_undated', 'event_timing_unconfirmed', 'event_date_bad_date', 'event_date_stale', 'event_date_future_date', 'no_event_evidence', 'no_sales_hiring_evidence', 'sales_hiring_check_failed', 'source_review_required', 'job_closed']
export const peopleSearchable = (reviewReason: string | null | undefined): boolean => reviewReason === null || reviewReason === undefined || SEARCHABLE_HOLDS.includes(reviewReason)
// How many searches the pass could use on these rows: distinct companies among the rows it will read (a company name, not graded out
// of the list (fit 0-1), ready or held under a searchable hold). The runner reserves a free-trial scan's searches from this count
// before the scan finishes, so a row the pass never reads reserves nothing.
export function searchableCompanyCount(rows: readonly { company?: unknown; review_reason?: unknown; fit?: unknown }[], keyOf: (company: string) => string): number {
  const keys = new Set<string>()
  for (const r of rows) {
    if (typeof r.company !== 'string' || r.company === '') continue
    if (typeof r.fit === 'number' && r.fit <= 1) continue
    if (r.review_reason !== null && r.review_reason !== undefined && !(typeof r.review_reason === 'string' && SEARCHABLE_HOLDS.includes(r.review_reason))) continue
    keys.add(keyOf(r.company))
  }
  return keys.size
}
