// What the test-account fixture controls (app/app/leads/verification-fixture.tsx) do with a route response. Pure, so it
// is tested without a browser (test/fixture-action-result.test.ts).

// After a successful first-touch or work-email (#1036) create, open its play so the lead is on screen under "Needs your review" (the
// past-scans list is not refreshed in place). Any other action, a failure or a malformed id: stay.
export function fixtureNextUrl(method: 'POST' | 'DELETE', action: string | undefined, ok: boolean, body: unknown): string | null {
  if (!ok || method !== 'POST' || (action !== 'first_touch' && action !== 'work_email') || !body || typeof body !== 'object') return null
  const jobId = (body as { jobId?: unknown }).jobId
  return typeof jobId === 'string' && /^[a-f0-9]{24}$/.test(jobId) ? `/app/leads?job_id=${jobId}` : null
}

// The one status line shown after a failed fixture action: explicit for the cleanup refusals, generic otherwise.
export function fixtureFailureMessage(status: number | null, body: unknown): string {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  // Both refusals come from the first-touch fixture's cleanup, which a plain "remove the verification fixture" also runs
  // first; a refusal stops the whole cleanup, so nothing of any fixture was removed.
  if (code === 'send_in_flight') return 'Nothing was removed: a message to the first-touch fixture lead is still sending or its outcome is uncertain. Resolve it first, then remove the fixtures.'
  if (code === 'recent_send') return 'Nothing was removed: a message to the first-touch fixture lead was sent recently and still counts toward the send limits (24 hours, or 7 days for a first touch). Try again after that.'
  // #1036 work-email fixture: what is missing before it can show its outcomes, or a lookup still running on it.
  if (code === 'needs_pdl_key') return 'Save a People Data Labs key first (Settings > Enrichment; on staging any string works, the fake answers).'
  if (code === 'needs_mailbox_check') return 'The mailbox check cannot run here now (EMAIL_GUESS_ENABLED, EMAIL_VERIFY_DAILY_CAP or this month\'s allowance). Nothing was created.'
  if (code === 'staging_fakes_only') return 'Only on staging with the fake People Data Labs and fake ZeroBounce turned on. Nothing was created.'
  if (code === 'lookup_in_flight') return 'Nothing was removed: a Find work email lookup on the fixture lead is still running. Try again in a minute.'
  if (status === 429) return 'Too many requests. Wait a minute and try again.'
  return status ? `That did not work (error ${status}). Try again.` : 'That did not work: no response. Check your connection and try again.'
}
