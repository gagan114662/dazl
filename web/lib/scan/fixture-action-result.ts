// What the test-account fixture controls (app/app/leads/verification-fixture.tsx) do with a route response. Pure, so it
// is tested without a browser (test/fixture-action-result.test.ts).

// After a successful first-touch create, open its play so the lead is on screen under "Needs your review" (the
// past-scans list is not refreshed in place). Any other action, a failure or a malformed id: stay.
export function fixtureNextUrl(method: 'POST' | 'DELETE', action: string | undefined, ok: boolean, body: unknown): string | null {
  if (!ok || method !== 'POST' || action !== 'first_touch' || !body || typeof body !== 'object') return null
  const jobId = (body as { jobId?: unknown }).jobId
  return typeof jobId === 'string' && /^[a-f0-9]{24}$/.test(jobId) ? `/app/leads?job_id=${jobId}` : null
}

// The one status line shown after a failed fixture action: explicit for the cleanup refusals, generic otherwise.
export function fixtureFailureMessage(status: number | null, body: unknown): string {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  if (code === 'send_in_flight') return 'Not removed: a message to the fixture lead is still sending or its outcome is uncertain. Resolve it first, then remove the fixture.'
  if (code === 'recent_send') return 'Not removed: a message to the fixture lead was sent in the last 24 hours and still counts toward the daily send limit. Try again once it is 24 hours old.'
  if (status === 429) return 'Too many requests. Wait a minute and try again.'
  return status ? `That did not work (error ${status}). Try again.` : 'That did not work: no response. Check your connection and try again.'
}
