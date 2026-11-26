// Pure (no db or network imports) so the client Leads page can use the same rule as the server.
// Rows held because the "company" is a person's handle or the other side of a post: no company
// website to ground, so no search is offered. self_description rows stay eligible; weak intent is not
// "not a company", and the crawler's own domain-identity check refuses a homepage that does not name it.
export const NON_COMPANY_REVIEW = ['author_post', 'counterparty_signal']
export const companySearchEligible = (l: { human_confirmed_from?: string | null; source_kind?: string | null; company?: string | null }): boolean =>
  !!(l.company ?? '').trim() && l.source_kind !== 'test' && !NON_COMPANY_REVIEW.includes(l.human_confirmed_from ?? '')
// #1177: a customer-mention row (counterparty_signal — the cited page is another company's story that mentions this
// company) is not established by its cited page, but it is established when the company has a settled own site (a
// sitecrawl domain row on the evidence_own_domain basis, or a domain the user confirmed) read independently of that
// page. Callers that read the lead's rows pass that settled fact in; the pure rule above is unchanged, so no caller
// gains the exception on lead fields alone. author_post gets no exception: the "company" there is a person's handle.
export const counterpartySignal = (l: { human_confirmed_from?: string | null; review_reason?: string | null }): boolean =>
  l.human_confirmed_from === 'counterparty_signal' || l.review_reason === 'counterparty_signal'
// The counterparty path on its own: the row is a customer mention, its own site is settled (the caller passes
// that fact in, including any name match it requires), it names a company, and it is not a test row.
export const counterpartySettledPath = (l: { human_confirmed_from?: string | null; review_reason?: string | null; source_kind?: string | null; company?: string | null }, settled: boolean): boolean =>
  settled && counterpartySignal(l) && !!(l.company ?? '').trim() && l.source_kind !== 'test'
export const companySearchEligibleSettled = (l: { human_confirmed_from?: string | null; review_reason?: string | null; source_kind?: string | null; company?: string | null }, settled: boolean): boolean =>
  companySearchEligible(l) || counterpartySettledPath(l, settled)
// #1183, for launch: Find contact, "Look for a published contact on the company website" and Find work email run the older engine's
// site crawl (connectors/sitecrawl.ts), which can store a job title as a person. A lead from the new engine (source_kind 'discover')
// already carries the person and address its own run found, so those buttons are not OFFERED on it. Only what the page offers: the
// routes and the eligibility rule above, which the server reads, are unchanged.
type Offered = { human_confirmed_from?: string | null; source_kind?: string | null; company?: string | null }
export const oldCrawlOffered = (l: { source_kind?: string | null }): boolean => l.source_kind !== 'discover'
export const findContactOffered = (l: Offered): boolean => oldCrawlOffered(l) && companySearchEligible(l)
