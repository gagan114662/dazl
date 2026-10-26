// Display decisions for the leads list, kept in lib so the copy is unit-testable.

// The empty-list line. A finished scan can have zero visible leads while lower-fit
// leads sit behind the "show lower-fit leads" toggle - say that instead of claiming
// the scan found nothing.
export function emptyLeadsMessage(status: string, visibleCount: number, hiddenCount: number, needsReviewCount?: number | null): string | null {
  if (visibleCount > 0) return null
  if (status === 'pending') return 'This scan is queued and has not started yet. Leads appear here after it runs.'
  if (status === 'running') return 'This scan is still running. Leads appear here when it finishes.'
  if (status === 'loading') return 'Loading this scan...'
  if (status === 'failed') return 'This scan ended without leads. See the message above.'
  if (status !== 'done') return 'No leads yet. Run a scan.'
  if (hiddenCount > 0) return `The scan found nothing above your fit bar - ${hiddenCount} lower-fit lead${hiddenCount === 1 ? ' is' : 's are'} hidden below.`
  // An all-review scan shows its cards below - 'no leads' would contradict them.
  if ((needsReviewCount ?? 0) > 0) return `No leads passed verification. ${needsReviewCount} need${needsReviewCount === 1 ? 's' : ''} your review below.`
  return 'The scan finished with no leads.'
}

// A lead with fit 0 is not a prospect (ICP mismatch). Showing its raw signal score
// next to the company name reads as "great lead", so say what the number means.
// A lead held at fit 0 because grading failed (no intent grade) is not "not a fit" -
// it was never graded, so the label says scoring failed instead.
// Leads saved by hand or from a job feed never get a grade; the stored 50 is only a column default.
// The headline next to a lead. Issue #198: "score 85" (the discovery relevance score) read as a hot lead while the
// grading said there was no reason to contact now (intent 0). A graded lead now shows its grade - fit, and whether a
// live trigger was confirmed - and the raw relevance score is only shown, labelled as such, for ungraded leads.
export function scoreLabel(score: number, fit: number | null, intent?: number | null, sourceKind?: string | null): string {
  if (fit == null && (sourceKind === 'hiring_feed' || sourceKind === 'manual_source')) return 'not graded'
  if (fit === 0) return intent == null ? 'scoring failed' : 'not a fit'
  if (fit == null) return `relevance ${score} (not graded)`
  return `fit ${fit}/5${intent == null ? '' : intent === 0 ? ', no live trigger confirmed' : `, timing ${intent}/5`}`
}

// A literal page check that found the quote is a real stored fact; only its meaning, date and need stay unverified.
export function quoteNote(literalFound: boolean | undefined): { prefix: string; confirmed: string } {
  return literalFound
    ? { prefix: 'Quote found on the page by a literal check (its meaning, date and need are not verified): ', confirmed: 'confirmed by you - the quote was found on the page by a literal check; dazl did not verify its meaning, date or need' }
    : { prefix: 'Unconfirmed quote: ', confirmed: 'confirmed by you - dazl did not verify the quote' }
}
