// Pure (no db or network imports) so the client Leads page can use the same rule as the server.
// Rows held because the "company" is a person's handle or the other side of a post: no company
// website to ground, so no search is offered. self_description rows stay eligible; weak intent is not
// "not a company", and the crawler's own domain-identity check refuses a homepage that does not name it.
import { identityOf } from './opportunity.ts'

export const NON_COMPANY_REVIEW = ['author_post', 'counterparty_signal']
export const COUNTERPARTY_REVIEW = 'counterparty_signal'

// The fields the rule reads: the stored website rows ('domain' and the user's 'domain_review') and the cited page.
export interface EligibleRow { id?: string; contact?: string | null; source_url?: string | null; enrichments?: { connector: string; kind: string; value: string; label?: string | null; source_url?: string | null }[] | null }

const hostOf = (u: string | null | undefined): string | null => {
  try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : null } catch { return null }
}
const sameOrSub = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

// #1177: a customer mention (counterparty_signal) is a verdict about the CITED page: another company's page that names this one as
// its customer. The company itself is established independently of that page when the row has its OWN settled website: exactly
// one website recorded, read from a page hosted on that website (identityOf 'fact' = evidence_own_domain). That website must not
// be the cited page's own site (the other company's): a site read from the vendor's page is the vendor's, never this company's.
// A website only linked from, or guessed from, the vendor's page, several websites, or the user's review alone does not settle it.
export function counterpartyOwnSite(l: EligibleRow): string | null {
  const id = identityOf({ id: l.id, contact: l.contact ?? null }, l.enrichments ?? [])
  if (!id || id.state !== 'fact' || !id.site) return null
  const cited = hostOf(l.source_url)
  if (!cited || sameOrSub(cited, id.site.toLowerCase())) return null
  return id.site
}

// Is this hold one that leaves the row without a company of its own? author_post always; counterparty_signal unless the row has
// its own settled website (above). Every other reason is a company row.
export const nonCompanyHold = (reason: string | null | undefined, l: EligibleRow): boolean =>
  reason === COUNTERPARTY_REVIEW ? !counterpartyOwnSite(l) : NON_COMPANY_REVIEW.includes(reason ?? '')

export const companySearchEligible = (l: EligibleRow & { human_confirmed_from?: string | null; source_kind?: string | null; company?: string | null }): boolean =>
  !!(l.company ?? '').trim() && l.source_kind !== 'test' && !nonCompanyHold(l.human_confirmed_from, l)
