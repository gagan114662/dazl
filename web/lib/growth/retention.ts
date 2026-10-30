// THE retention definition for dazl's own funnel (issue #404). Both funnel implementations use this module (the
// acquisition funnel, lib/growth/lifecycle.ts, and the cohort lifecycle report); neither defines retention itself.
// Pure: plain numbers in, plain answers out, no store, no clock.
//
// Headline: RETAINED AT 30 DAYS (headline_days). Two further rules, each its own named setting. Their 5-day values are
// carried-over defaults, not owner decisions; change them here, and every report changes with them:
//   renewal_early_days   a renewal counts if paid at least headline - renewal_early_days after the first payment
//                        (a monthly invoice can post a few days before the 30-day mark)
//   maturity_extra_days  a customer is ELIGIBLE (judged at all) once their first payment is at least
//                        headline + maturity_extra_days before the cutoff (time for a late renewal to post)
// Every eligible customer is in the denominator, and only eligible customers can be in the numerator, so the rate can
// never exceed 100%. An eligible customer is retained when BOTH kinds of evidence hold:
//   renewal   a paid, not refunded payment at least headline - renewal_early_days after the first one, by the cutoff
//             (they actually paid again, not merely failed to cancel)
//   coverage  their subscription had not ended by first payment + headline_days (still a customer at the mark)
// Each piece of evidence is also returned on its own, labelled, so a report can show why a customer is or is not
// retained. Current coverage at the cutoff (covered_at_cutoff) is reported beside the headline, never mixed into it.
// Times are unix seconds. Callers pass only what happened on or before the cutoff; anything later is ignored here too.

export const RETENTION = {
  headline_days: 30,
  renewal_early_days: 5,     // default carried over, not an owner decision
  maturity_extra_days: 5,    // default carried over, not an owner decision
  label: 'Retained at 30 days: of paying customers whose first payment is at least 35 days old (30 + 5 maturity), those who paid a renewal 25+ days after it (30 - 5 early) and had not ended their subscription by day 30. The two 5-day rules are defaults',
} as const
export interface RetentionRules { headlineDays?: number; renewalEarlyDays?: number; maturityExtraDays?: number }
const DAY = 86400

export interface RetentionInput {
  payments: { at: number; refunded: boolean }[]   // paid payments (amount above 0); refunded = fully refunded
  ended_at: number | null                         // when the subscription ended, if it has
  cutoff: number                                  // the report's as-of time
}
export interface RetentionResult {
  first_paid_at: number | null
  eligible: boolean                // in the denominator
  renewal: boolean                 // evidence: paid again 25+ days after the first payment, by the cutoff
  covered_at_headline: boolean     // evidence: subscription not ended by first payment + 30 days
  covered_at_cutoff: boolean | null // reported separately: still covered at the cutoff (null: never paid)
  retained: boolean | null         // the headline; null when not eligible
}

export function retention(i: RetentionInput, o: RetentionRules = {}): RetentionResult {
  const headline = (o.headlineDays ?? RETENTION.headline_days) * DAY
  const early = (o.renewalEarlyDays ?? RETENTION.renewal_early_days) * DAY, extra = (o.maturityExtraDays ?? RETENTION.maturity_extra_days) * DAY
  const paid = i.payments.filter(p => !p.refunded && p.at <= i.cutoff).map(p => p.at).sort((a, b) => a - b)
  const first = paid[0] ?? null
  const ended = i.ended_at !== null && i.ended_at <= i.cutoff ? i.ended_at : null
  if (first === null) return { first_paid_at: null, eligible: false, renewal: false, covered_at_headline: false, covered_at_cutoff: null, retained: null }
  const eligible = i.cutoff - first >= headline + extra
  const renewal = paid.some(t => t - first >= headline - early)
  const coveredAtHeadline = ended === null || ended > first + headline
  return { first_paid_at: first, eligible, renewal, covered_at_headline: coveredAtHeadline, covered_at_cutoff: ended === null, retained: eligible ? renewal && coveredAtHeadline : null }
}

// The headline rate over a set of customers: numerator and denominator from the same eligible cohort.
export function retentionRate(results: RetentionResult[]): { retained: number; eligible: number; rate: number | null; label: string } {
  const eligible = results.filter(r => r.eligible)
  const retained = eligible.filter(r => r.retained === true).length
  return { retained, eligible: eligible.length, rate: eligible.length ? retained / eligible.length : null, label: RETENTION.label }
}
