// Retry backoff for queue items. The current runner re-pends a failed attempt
// immediately (failOrRetry in web/lib/scan/runner.ts), so a provider outage
// burns all MAX_ATTEMPTS in seconds. A claimable-at timestamp (notBefore)
// plus exponential backoff keeps the retry semantics but spaces them out.

export interface BackoffPolicy {
  baseSeconds: number
  factor: number
  capSeconds: number
  // Fractional jitter band, e.g. 0.2 = +/-20%, so tenants retrying after a
  // shared provider outage do not synchronize into a thundering herd.
  jitter: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseSeconds: 30, factor: 2, capSeconds: 30 * 60, jitter: 0.2 }

// attempt is 1-based (the attempt that just failed). Deterministic given rng,
// so tests inject a fixed rng and production uses Math.random.
export function backoffSeconds(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, rng: () => number = Math.random): number {
  const exp = Math.min(policy.capSeconds, policy.baseSeconds * policy.factor ** Math.max(0, attempt - 1))
  const spread = exp * policy.jitter
  const offset = (rng() * 2 - 1) * spread
  return Math.max(0, Math.round(exp + offset))
}

export function nextEligibleAt(now: number, attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, rng?: () => number): number {
  return now + backoffSeconds(attempt, policy, rng)
}
