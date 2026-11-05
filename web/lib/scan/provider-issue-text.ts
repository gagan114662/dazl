// One plain sentence per recorded provider failure, for the scan view. Pure text: this module is
// imported by the browser bundle, so it must never pull the data layer or any server-only import.
// 'auth' names the key as the thing to fix; nothing here guesses WHY a provider rate-limited or errored.

// The only statuses that mean the PROVIDER failed (EnrichError codes + the generic catch).
// 'ok', 'empty' and the agreement-rejection sentences are outcomes, not provider failures.
export const PROVIDER_FAILURE_STATUSES = ['auth', 'rate_limited', 'upstream', 'timeout', 'error'] as const
export type ProviderFailureStatus = (typeof PROVIDER_FAILURE_STATUSES)[number]
// Enrichment waterfall skips (#382): not provider failures, but lookups that did NOT happen for some leads of this
// scan. Each is audited once per provider per pass (lib/enrich/index.ts), so these carry no per-lookup count.
export const ENRICH_SKIP_STATUSES = ['budget_exhausted', 'circuit_open', 'uncertain', 'fallback_off', 'credit_cap', 'credit_unsaved'] as const
export type EnrichSkipStatus = (typeof ENRICH_SKIP_STATUSES)[number]

export interface ProviderIssue {
  connector: string
  status: ProviderFailureStatus | EnrichSkipStatus
  lookups_affected: number
  latest_at: number
  // credit_cap only, read from the credit pool when the issue is listed: which window, credits used against the limit.
  credit?: { window: 'day' | 'month'; used: number; limit: number }
}

export function providerIssueText(issue: ProviderIssue): string {
  const who = issue.connector === 'enrich:apollo' ? 'Apollo' : issue.connector === 'enrich:pdl' ? 'People Data Labs' : issue.connector
  const n = issue.lookups_affected
  const affected = n === 1 ? '1 lookup affected' : `${n} lookups affected`
  switch (issue.status) {
    case 'auth': return `${who} could not be used in this scan: the saved key was rejected. Check Settings > Enrichment.`
    case 'rate_limited': return `${who} rate limit reached during this scan (${affected}).`
    case 'upstream': return `${who} returned an error during this scan (${affected}).`
    case 'timeout': return `${who} did not answer in time during this scan (${affected}). Whether a timed-out lookup was billed is not known, so it is held, not retried automatically.`
    case 'budget_exhausted': return `${who} was not used for the remaining leads in this scan: the per-scan lookup limit was reached.`
    case 'circuit_open': return `${who} was skipped for the remaining leads in this scan after repeated failures.`
    case 'uncertain': return `${who}: an earlier lookup for a lead in this scan may have been billed but its result was not recorded, so it is held and was not repeated.`
    case 'fallback_off': return `People Data Labs was not tried for leads Apollo could not enrich: a key is saved, but the Apollo-to-PDL fallback is off (Settings > Enrichment).`
    case 'credit_cap': {
      const c = issue.credit
      const where = c ? `your workspace's ${c.window === 'day' ? 'daily' : 'monthly'} ${who} credit limit (${c.used} of ${c.limit} credits used this UTC ${c.window})` : `your workspace's ${who} credit limit`
      return `${who} enrichment was skipped for the remaining leads in this scan: the next paid lookup would have gone over ${where}, so it was not made. Raise or clear the limit in Settings > Enrichment.`
    }
    case 'credit_unsaved': return `${who} enrichment was skipped for the remaining leads in this scan: the workspace credit reservation could not be saved, so this skipped lookup was not made (it fails closed) and nothing was charged for it. Lookups earlier in the scan keep their own charges; run the scan again, and contact support if it repeats.`
    default: return `${who} could not be used in this scan (${affected}).`
  }
}
