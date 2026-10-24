// Pure (no db or network imports) so the client Leads page can use the same rule as the server.
// Rows held because the "company" is a person's handle or the other side of a post: no company
// website to ground, so no search is offered. self_description rows stay eligible; weak intent is not
// "not a company", and the crawler's own domain-identity check refuses a homepage that does not name it.
export const NON_COMPANY_REVIEW = ['author_post', 'counterparty_signal']
export const companySearchEligible = (l: { human_confirmed_from?: string | null; source_kind?: string | null; company?: string | null }): boolean =>
  !!(l.company ?? '').trim() && l.source_kind !== 'test' && !NON_COMPANY_REVIEW.includes(l.human_confirmed_from ?? '')

