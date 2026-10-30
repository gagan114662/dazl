// THE retention definitions for dazl's own funnel (issue #404). Both funnel implementations import this one file (the
// acquisition funnel, lib/growth/lifecycle.ts, and the cohort lifecycle report, lib/gtm/lifecycle.ts); neither defines
// retention or coverage itself. Pure: plain numbers in, plain answers out, no store, no clock. Times are unix seconds;
// anything after the cutoff is ignored.
//
// Two separate metrics, each with its own cohort and its own positive evidence. Neither treats "no cancellation was
// recorded" as proof of anything: an absent end event means only that no end event was recorded.
//
// 1. RETAINED AT DAY 30 (historical). Cohort: customers whose first paid payment is old enough that their day-30
//    renewal window has closed by the cutoff (first payment + headline + renewal_late_days). Retained: a paid, not
//    refunded renewal inside the window [first + headline - renewal_early_days, first + headline + renewal_late_days],
//    and no subscription end before day 30. A renewal after the window (a lapse, then a rejoin) is not day-30
//    retention. Numerator and denominator come from the same cohort, so the rate cannot exceed 100%.
// 2. COVERAGE AT A DATE (current, e.g. the cutoff). Cohort: every customer who has paid by that date. It uses each
//    payment's ACTUAL service periods, one interval per invoice line (a subscription line's period start and end),
//    never an assumed length and never one span from the earliest start to the latest end: an invoice for two
//    periods with a gap between them covers the two periods, not the gap. A payment with no service period (a
//    one-off charge) is no coverage evidence at all.
//      covered      one of a paid, not refunded payment's service intervals includes the date, and no recorded end
//                   had stopped the service first, or the payment came after that end (a rejoin)
//      not_covered  a recorded end stopped the service on or before the date, and nothing paid after it covers it
//      unknown      neither: no interval covers the date and no end was recorded; never reported as covered
//    Cancellation: an end is when the service actually stopped (Stripe's customer.subscription.deleted), and coverage
//    stops there. A cancellation scheduled for the end of the paid period is not an end: Stripe keeps the subscription
//    active and sends customer.subscription.deleted when the period ends (docs.stripe.com/billing/subscriptions/cancel),
//    so the paid interval covers the rest of the period until that end arrives.
// The 5-day values are carried-over defaults, not owner decisions; every report changes with them here.

export const RETENTION = {
  headline_days: 30,
  renewal_early_days: 5,   // a renewal may post this many days before day 30
  renewal_late_days: 5,    // ...or this many after; the cohort waits for the window to close
  labels: {
    day30: 'Retained at day 30 (historical). Cohort: paying customers whose day-30 renewal window (days 25-35 after the first payment) has closed. Retained: paid a renewal inside that window and had not ended by day 30',
    coverage: 'Covered at the cutoff (current). Cohort: every customer who has paid by the cutoff. Covered only when a paid invoice\'s actual service period includes the cutoff and no recorded end had stopped the service; "unknown" when no period covers it and no end was recorded',
  },
} as const
export interface RetentionRules { headlineDays?: number; renewalEarlyDays?: number; renewalLateDays?: number }
const DAY = 86400
const rules = (o: RetentionRules) => ({
  headline: (o.headlineDays ?? RETENTION.headline_days) * DAY, early: (o.renewalEarlyDays ?? RETENTION.renewal_early_days) * DAY,
  late: (o.renewalLateDays ?? RETENTION.renewal_late_days) * DAY,
})

export interface RetentionInput {
  // paid payments (amount above 0); refunded = fully refunded; periods = the service intervals it bought, one per
  // invoice line, each with the line's own identity (empty: a one-off charge, never coverage evidence)
  payments: { at: number; refunded: boolean; periods?: ServicePeriod[] }[]
  ended_at: number | null                         // when the service actually stopped (the latest end recorded), if any
  cutoff: number                                  // the report's as-of time
}
export type Coverage = 'covered' | 'not_covered' | 'unknown'
// [start, end) of one invoice line's service, with which subscription and price it is for
export interface ServicePeriod { start: number; end: number; subscription?: string | null; price?: string | null }
export interface RetentionResult {
  first_paid_at: number | null
  day30: { eligible: boolean; retained: boolean | null; renewal_at: number | null }
  coverage_at_cutoff: Coverage | null              // null: never paid by the cutoff (not in the coverage cohort)
}

const paidTimes = (i: RetentionInput, upTo: number) => i.payments.filter(p => !p.refunded && p.at <= upTo).map(p => p.at).sort((a, b) => a - b)

// Coverage at any date, on the evidence available up to that date.
export function coverageAt(i: RetentionInput, at: number): Coverage | null {
  const when = Math.min(at, i.cutoff)
  const paid = i.payments.filter(p => !p.refunded && p.at <= when)
  if (!paid.length) return null
  const ended = i.ended_at !== null && i.ended_at <= when ? i.ended_at : null
  // each interval on its own: the date must fall inside one of them, never in a gap between two
  const covering = paid.filter(p => (p.periods ?? []).some(iv => iv.end > iv.start && iv.start <= when && when < iv.end))
  // a covering interval counts unless the service had stopped first; a payment made after the end (a rejoin) counts
  if (covering.some(p => ended === null || p.at > ended)) return 'covered'
  if (ended !== null && !paid.some(p => p.at > ended)) return 'not_covered'
  return 'unknown'
}

export function retention(i: RetentionInput, o: RetentionRules = {}): RetentionResult {
  const r = rules(o)
  const paid = paidTimes(i, i.cutoff)
  const first = paid[0] ?? null
  if (first === null) return { first_paid_at: null, day30: { eligible: false, retained: null, renewal_at: null }, coverage_at_cutoff: null }
  const eligible = i.cutoff >= first + r.headline + r.late
  const renewal = paid.find(t => t >= first + r.headline - r.early && t <= first + r.headline + r.late) ?? null
  const endedBy30 = i.ended_at !== null && i.ended_at <= i.cutoff && i.ended_at <= first + r.headline
  return {
    first_paid_at: first,
    day30: { eligible, retained: eligible ? renewal !== null && !endedBy30 : null, renewal_at: renewal },
    coverage_at_cutoff: coverageAt(i, i.cutoff),
  }
}

// Day-30 retention over a set of customers: numerator and denominator from the same cohort, named in the result.
export function retentionRate(results: RetentionResult[]): { retained: number; eligible: number; rate: number | null; cohort: string; label: string } {
  const eligible = results.filter(x => x.day30.eligible)
  const retained = eligible.filter(x => x.day30.retained === true).length
  return { retained, eligible: eligible.length, rate: eligible.length ? retained / eligible.length : null, cohort: 'paying customers whose day-30 renewal window has closed', label: RETENTION.labels.day30 }
}
// Coverage at the cutoff over a set of customers: its own cohort (everyone who has paid), unknown kept apart.
export function coverageCounts(results: RetentionResult[]): { covered: number; not_covered: number; unknown: number; cohort_size: number; cohort: string; label: string } {
  const c = results.filter(x => x.coverage_at_cutoff !== null)
  return {
    covered: c.filter(x => x.coverage_at_cutoff === 'covered').length, not_covered: c.filter(x => x.coverage_at_cutoff === 'not_covered').length,
    unknown: c.filter(x => x.coverage_at_cutoff === 'unknown').length, cohort_size: c.length, cohort: 'every customer who has paid by the cutoff', label: RETENTION.labels.coverage,
  }
}
