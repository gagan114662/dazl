// Display decisions for the leads list, kept in lib so the copy is unit-testable.

// The empty-list line. A finished scan can have zero visible leads while lower-fit
// leads sit behind the "show lower-fit leads" toggle - say that instead of claiming
// the scan found nothing.
export function emptyLeadsMessage(status: string, visibleCount: number, hiddenCount: number, needsReviewCount?: number | null): string | null {
  if (visibleCount > 0) return null
  if (status !== 'done') return 'No leads yet. Run a scan.'
  if (hiddenCount > 0) return `The scan found nothing above your fit bar - ${hiddenCount} lower-fit lead${hiddenCount === 1 ? ' is' : 's are'} hidden below.`
  // An all-review scan shows its cards below - 'no leads' would contradict them.
  if ((needsReviewCount ?? 0) > 0) return `No leads passed verification. ${needsReviewCount} need your review below.`
  return 'The scan finished with no leads.'
}

// A lead with fit 0 is not a prospect (ICP mismatch). Showing its raw signal score
// next to the company name reads as "great lead", so say what the number means.
// A lead held at fit 0 because grading failed (no intent grade) is not "not a fit" -
// it was never graded, so the label says scoring failed instead.
export function scoreLabel(score: number, fit: number | null, intent?: number | null): string {
  if (fit === 0) return intent == null ? 'scoring failed' : 'not a fit'
  return `score ${score}`
}
