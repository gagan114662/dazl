// #1715: the Leads page 'Dropped:' line used to glue a count onto a noun phrase written for one page
// ('Dropped: 4 page no longer exists.'). Each drop reason renders here as a complete plain phrase whose
// noun and verb agree with the count, so 1 and 4 both read correctly. Pure and dependency-free: the
// client renders it, and the wording is pinned by web/test/leads-copy-1715b.test.ts.
const PHRASES: Record<string, [string, string]> = {
  excerpt_not_on_page: ['quote was not on the page', 'quotes were not on the page'],
  no_excerpt: ['page had no usable quote', 'pages had no usable quote'],
  entity_mismatch: ['quote did not name the company', 'quotes did not name the company'],
  no_company: ['page had no company name', 'pages had no company name'],
  stale: ['page was older than 12 months', 'pages were older than 12 months'],
  date_conflict: ['page showed an older date', 'pages showed an older date'],
  future_date: ['date was in the future', 'dates were in the future'],
  bad_date: ['date could not be read', 'dates could not be read'],
  low_confidence: ['check was not certain enough', 'checks were not certain enough'],
  contradicted: ['page contradicted the claim', 'pages contradicted the claim'],
  claim_unclear: ['page did not clearly support the claim', 'pages did not clearly support the claim'],
  page_unreachable: ['page could not be loaded', 'pages could not be loaded'],
  page_not_found: ['page was gone', 'pages were gone'],
  source_cap: ['quote was over the 3-per-page cap', 'quotes were over the 3-per-page cap'],
  url_refused: ['address was unsafe or unsupported', 'addresses were unsafe or unsupported'],
  duplicate: ['company was a duplicate', 'companies were duplicates'],
}
const FALLBACK: [string, string] = ['lead was dropped for another reason', 'leads were dropped for another reason']

// Own keys only: a stored reason such as 'constructor' is an unknown reason, never an Object.prototype member.
export function dropReasonText(reason: string, count: number): string {
  const pair = Object.prototype.hasOwnProperty.call(PHRASES, reason) ? PHRASES[reason] : FALLBACK
  return `${count} ${count === 1 ? pair[0] : pair[1]}`
}

export function dropReasonsLine(dropReasons: Record<string, number>): string {
  const parts = Object.entries(dropReasons).filter(([, n]) => n > 0).map(([reason, n]) => dropReasonText(reason, n))
  return parts.length ? `Dropped: ${parts.join(', ')}.` : ''
}
