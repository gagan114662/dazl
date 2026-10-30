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
//    payment's ACTUAL service period (the invoice line's period start and end), never an assumed length: a monthly,
//    annual or prorated period is whatever the billing says, and a payment with no service period (a one-off charge)
//    is no coverage evidence at all.
//      covered      a paid, not refunded payment's service period includes the date, and the service had not been
//                   stopped by a recorded end (see below), or the payment came after that end (a rejoin)
//      not_covered  a recorded end stopped the service on or before the date, and nothing paid after it covers it
//      unknown      neither: no service period covers the date and no end was recorded; never reported as covered
//    Cancellation versus prepaid service: an end stops the service at its own date (an immediate cancellation), unless
//    the billing evidence says the paid service runs on (service_until, e.g. Stripe's ended_at or cancel_at for a
//    cancellation at period end). An end on day 5 is not covered on day 10 unless service_until says otherwise.
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
  // paid payments (amount above 0); refunded = fully refunded; period = the service period it bought, from the invoice
  // (absent: a one-off charge, or a payment recorded without one: never coverage evidence)
  payments: { at: number; refunded: boolean; period_start?: number | null; period_end?: number | null }[]
  ended_at: number | null                         // the latest subscription end recorded, if any
  service_until?: number | null                   // billing evidence that the paid service ran on past that end
  cutoff: number                                  // the report's as-of time
}
export type Coverage = 'covered' | 'not_covered' | 'unknown'
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
  // when a recorded end stopped the service: at the end itself, or later if billing says the paid service ran on
  const stop = ended === null ? null : Math.max(ended, i.service_until ?? ended)
  const covering = paid.filter(p => p.period_start != null && p.period_end != null && p.period_start <= when && when < p.period_end)
  // a covering period counts unless the service was stopped first; a payment made after the end (a rejoin) counts
  if (covering.some(p => stop === null || when < stop || p.at > ended!)) return 'covered'
  if (stop !== null && when >= stop && !paid.some(p => p.at > ended!)) return 'not_covered'
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
