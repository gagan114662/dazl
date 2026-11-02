// One plain sentence per recorded provider failure, for the scan view. Pure text: this module is
// imported by the browser bundle, so it must never pull the data layer or any server-only import.
// 'auth' names the key as the thing to fix; nothing here guesses WHY a provider rate-limited or errored.

// The only statuses that mean the PROVIDER failed (EnrichError codes + the generic catch).
// 'ok', 'empty' and the agreement-rejection sentences are outcomes, not provider failures.
export const PROVIDER_FAILURE_STATUSES = ['auth', 'rate_limited', 'upstream', 'error'] as const
export type ProviderFailureStatus = (typeof PROVIDER_FAILURE_STATUSES)[number]

export interface ProviderIssue {
  connector: string
  status: ProviderFailureStatus
  lookups_affected: number
  latest_at: number
}

export function providerIssueText(issue: ProviderIssue): string {
  const who = issue.connector === 'enrich:apollo' ? 'Apollo' : issue.connector === 'enrich:pdl' ? 'People Data Labs' : issue.connector
  const n = issue.lookups_affected
  const affected = n === 1 ? '1 lookup affected' : `${n} lookups affected`
  switch (issue.status) {
    case 'auth': return `${who} could not be used in this scan: the saved key was rejected. Check Settings > Enrichment.`
    case 'rate_limited': return `${who} rate limit reached during this scan (${affected}).`
    case 'upstream': return `${who} returned an error during this scan (${affected}).`
    default: return `${who} could not be used in this scan (${affected}).`
  }
}
