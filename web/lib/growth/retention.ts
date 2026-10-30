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
//    refunded renewal inside the window [first + headline - renewal_early_days, first + headline + renewal_late_days]
//    for a subscription that had not ended by day 30 (ends are scoped: a sibling subscription ending does not count),
//    and that subscription must CONTINUE a first-paid service: it was on the first paid invoice. A completely new
//    subscription first paid inside the window, or a restart after the first service ended, is a new service, not
//    retention (day30.outcome 'new_service'). A renewal or first invoice that names no subscription cannot show that
//    continuity and is not counted as retained (outcome 'unverified').
//    A renewal after the window (a lapse, then a rejoin) is not day-30 retention. Numerator and denominator come from the same cohort, so the rate cannot exceed 100%.
// 2. COVERAGE AT A DATE (current, e.g. the cutoff). Cohort: every customer who has paid by that date. It uses each
//    payment's ACTUAL service periods, one interval per invoice line (a subscription line's period start and end),
//    never an assumed length and never one span from the earliest start to the latest end: an invoice for two
//    periods with a gap between them covers the two periods, not the gap. A payment with no service period (a
//    one-off charge) is no coverage evidence at all.
//      covered      one of a paid, not refunded payment's service intervals includes the date, and no end of THAT
//                   interval's subscription had stopped it first (an end recorded after the payment, on or before
//                   the date); a payment after the end (a rejoin) counts
//      not_covered  every subscription the customer paid for has a recorded end on or before the date, and nothing
//                   paid after its end covers the date
//      unknown      neither; never reported as covered
//    Ends are scoped to their subscription: deleting one subscription never stops another one's paid service. An end
//    that names no subscription (when the billing cannot say which) stops all of them, and an interval that names no
//    subscription is stopped by any end, so missing identity never invents coverage.
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
  // every recorded end: when that subscription's service actually stopped (subscription null: all of them)
  ends: { at: number; subscription?: string | null }[]
  cutoff: number                                  // the report's as-of time
}
export type Coverage = 'covered' | 'not_covered' | 'unknown'
// [start, end) of one invoice line's service, with which subscription and price it is for
export interface ServicePeriod { start: number; end: number; subscription?: string | null; price?: string | null }
export type Day30Outcome = 'renewed' | 'new_service' | 'unverified' | 'none'
export interface RetentionResult {
  first_paid_at: number | null
  // outcome: 'renewed' (retained), 'new_service' (only a new or restarted subscription paid in the window),
  // 'unverified' (a window payment whose continuity cannot be shown: no subscription identity), 'none' (nothing paid
  // in the window); null while not yet eligible
  day30: { eligible: boolean; retained: boolean | null; renewal_at: number | null; outcome: Day30Outcome | null }
  coverage_at_cutoff: Coverage | null              // null: never paid by the cutoff (not in the coverage cohort)
}

const paidTimes = (i: RetentionInput, upTo: number) => i.payments.filter(p => !p.refunded && p.at <= upTo).map(p => p.at).sort((a, b) => a - b)

// Coverage at any date, on the evidence available up to that date.
export function coverageAt(i: RetentionInput, at: number): Coverage | null {
  const when = Math.min(at, i.cutoff)
  const paid = i.payments.filter(p => !p.refunded && p.at <= when)
  if (!paid.length) return null
  const ends = i.ends.filter(e => e.at <= when)
  // an end applies to an interval when it names the interval's subscription, names none, or the interval names none
  const applies = (e: { subscription?: string | null }, sub: string | null | undefined) => !e.subscription || !sub || e.subscription === sub
  // stopped: an applicable end recorded after this payment (a payment after the end, a rejoin, is not stopped by it)
  const stopped = (at: number, sub: string | null | undefined) => ends.some(e => applies(e, sub) && e.at >= at)
  // each interval on its own: the date must fall inside one of them, never in a gap between two
  for (const p of paid) for (const iv of p.periods ?? [])
    if (iv.end > iv.start && iv.start <= when && when < iv.end && !stopped(p.at, iv.subscription)) return 'covered'
  // not covered: every subscription paid for (or the customer as a whole, when no identity is known) has ended since
  // its last payment
  // a payment with no service period, or a period with no subscription, belongs to an unknown subscription (null)
  const subsOf = (p: typeof paid[number]) => (p.periods ?? []).length ? (p.periods ?? []).map(iv => iv.subscription ?? null) : [null]
  const subs = [...new Set(paid.flatMap(subsOf))]
  const lastPaid = (sub: string | null) => Math.max(...paid.filter(p => subsOf(p).includes(sub)).map(p => p.at))
  const allEnded = subs.every(sub => stopped(lastPaid(sub), sub))
  return allEnded ? 'not_covered' : 'unknown'
}

export function retention(i: RetentionInput, o: RetentionRules = {}): RetentionResult {
  const r = rules(o)
  const paid = paidTimes(i, i.cutoff)
  const first = paid[0] ?? null
  if (first === null) return { first_paid_at: null, day30: { eligible: false, retained: null, renewal_at: null, outcome: null }, coverage_at_cutoff: null }
  const eligible = i.cutoff >= first + r.headline + r.late
  // a renewal is retention only when it continues a first-paid service: its subscription was on the first paid
  // invoice and had not ended by day 30. Another subscription on the same customer ending (a sibling on the first
  // invoice) does not undo it. Missing identity (a renewal or first invoice naming no subscription) never invents
  // retention: it is 'unverified'.
  const endsBy30 = i.ends.filter(e => e.at <= i.cutoff && e.at <= first + r.headline)
  const subsOf = (p: RetentionInput['payments'][number]) => (p.periods ?? []).length ? (p.periods ?? []).map(iv => iv.subscription ?? null) : [null]
  const firstSubs = new Set(i.payments.filter(p => !p.refunded && p.at === first).flatMap(subsOf))
  const continues = (sub: string | null) => sub !== null && firstSubs.has(sub) && !endsBy30.some(e => !e.subscription || e.subscription === sub)
  const inWindow = i.payments.filter(p => !p.refunded && p.at <= i.cutoff && p.at >= first + r.headline - r.early && p.at <= first + r.headline + r.late)
    .sort((a, b) => a.at - b.at)
  const renewal = inWindow.find(p => subsOf(p).some(continues))?.at ?? null
  const unproven = firstSubs.has(null) || inWindow.some(p => subsOf(p).includes(null))
  const outcome: Day30Outcome = renewal !== null ? 'renewed' : !inWindow.length ? 'none' : unproven ? 'unverified' : 'new_service'
  return {
    first_paid_at: first,
    day30: { eligible, retained: eligible ? renewal !== null : null, renewal_at: renewal, outcome: eligible ? outcome : null },
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
