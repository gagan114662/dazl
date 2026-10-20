// A finished scan with nothing to list says which case it was, so it is never a silent zero.
export function emptyMessage(q: { candidates: number; needs_review: number | null } | null): string {
  if (!q) return 'The scan finished with no leads.'
  if (q.candidates === 0) return 'The search returned no candidates. Try describing the buyer differently, widen the region or industry, or check that your key has web search access.'
  if ((q.needs_review ?? 0) > 0) return `No leads passed verification. ${q.needs_review} need your review below.`
  return `${q.candidates} candidates were found but none passed verification. The reasons are listed above. Try a request that names a more specific, recent buying signal.`
}

