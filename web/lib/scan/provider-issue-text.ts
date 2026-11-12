// One plain sentence per recorded provider failure, for the scan view. Pure text: this module is
// imported by the browser bundle, so it must never pull the data layer or any server-only import.
// 'auth' names the key as the thing to fix; nothing here guesses WHY a provider rate-limited or errored.

// The only statuses that mean the PROVIDER failed (EnrichError codes + the generic catch).
// 'ok', 'empty' and the agreement-rejection sentences are outcomes, not provider failures.
export const PROVIDER_FAILURE_STATUSES = ['auth', 'rate_limited', 'upstream', 'timeout', 'error'] as const
export type ProviderFailureStatus = (typeof PROVIDER_FAILURE_STATUSES)[number]
// Enrichment waterfall skips (#382): not provider failures, but lookups that did NOT happen for some leads of this
// scan. Each is audited once per provider per pass (lib/enrich/index.ts), so these carry no per-lookup count.
// 'key_rejected' (#382): opened by ONE rejected key, so it is never called "repeated failures". 'spend_refused' (#382): dazl's own
// spend gate refused the lookup before it was sent - the provider was not tried and did not fail; its reason is on the audit row's
// lookup (SPEND_REFUSAL_PREFIX + reason, written by lib/enrich/index.ts).
export const ENRICH_SKIP_STATUSES = ['budget_exhausted', 'circuit_open', 'key_rejected', 'spend_refused', 'uncertain', 'fallback_off', 'credit_cap', 'credit_unsaved'] as const
export const SPEND_REFUSAL_PREFIX = 'spend refused: '
export type EnrichSkipStatus = (typeof ENRICH_SKIP_STATUSES)[number]

export interface ProviderIssue {
  connector: string
  status: ProviderFailureStatus | EnrichSkipStatus
  lookups_affected: number
  latest_at: number
  // credit_cap only, read from the credit pool when the issue is listed: which window, credits used against the limit.
  credit?: { window: 'day' | 'month'; used: number; limit: number; requested: number }
  // spend_refused only: the spend gate's refusal reason (lib/scan/spend-cap.ts), read from the skip's audit row.
  refusal?: string
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
    case 'key_rejected': return `${who} was skipped for the remaining leads in this scan after the saved key was rejected.`
    case 'spend_refused': return `${who} not tried for the remaining leads in this scan: ${spendRefusalText(issue.refusal)} Nothing was sent to ${who} for those leads, so nothing was charged for them.`
    case 'uncertain': return `${who}: an earlier lookup for a lead in this scan may have been billed but its result was not recorded, so it is held and was not repeated.`
    case 'fallback_off': return `People Data Labs was not tried for leads Apollo could not enrich: a key is saved, but the Apollo-to-PDL fallback is off (Settings > Enrichment).`
    case 'credit_cap': {
      const c = issue.credit
      if (!c) return `${who} enrichment was skipped for the remaining leads in this scan: a ${who} credit limit for your workspace stopped the next paid lookup, so it was not made. Raise or clear the limit in Settings > Enrichment.`
      const win = `${c.window === 'day' ? 'daily' : 'monthly'} ${who} credit limit (${c.used} of ${c.limit} credits used this UTC ${c.window})`
      const why = c.used >= c.limit ? `your workspace's ${win} was reached` : `the next lookup needed ${c.requested} credit${c.requested === 1 ? '' : 's'} and only ${c.limit - c.used} remained under your workspace's ${win}`
      return `${who} enrichment was skipped for the remaining leads in this scan: ${why}, so no paid lookup was made. Raise or clear the limit in Settings > Enrichment.`
    }
    case 'credit_unsaved': return `${who} enrichment was skipped for the remaining leads in this scan: the workspace credit reservation could not be saved, so this skipped lookup was not made (it fails closed) and nothing was charged for it. Lookups earlier in the scan keep their own charges; run the scan again, and contact support if it repeats.`
    default: return `${who} could not be used in this scan (${affected}).`
  }
}

// Why dazl's own spend gate refused an enrichment lookup before sending it (lib/scan/spend-cap.ts reasons). States only what the
// reason proves; an unknown reason is named as such, never guessed.
function spendRefusalText(reason: string | undefined): string {
  switch (reason) {
    case 'provider_rejected': return 'it refused an earlier paid request in this scan (a rejected key or a rate limit), and dazl never sends it another request after a refusal.'
    case 'scan_provider_rejected': return "the scan's AI or search provider refused an earlier request, so dazl made no further paid request in this scan."
    case 'accounting_uncertain': return 'an earlier paid request in this scan may have been billed without a confirmed cost (it timed out or the provider failed), so dazl made no further paid request in this scan.'
    case 'over_cap': case 'over_limit': return "this scan's spending cap had no room left for the lookup."
    case 'trial_budget_reached': return "this free scan's spending limit had no room left for the lookup."
    default: return `dazl's spend check refused the lookup before it was sent${reason ? ` (${reason})` : ''}.`
  }
}
