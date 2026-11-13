// #1036 live check (Hermes 2026-11-13 18:43Z, staging lead "Benesch"): a lead under "Needs your review" (for example one with no
// event date) showed no people and no Find work email until the user clicked "Keep as research", although the server already
// allows the lookup on it. The buyer's work email does not depend on the review: the review is about the signal, and the lookup
// needs only a settled company website and a buyer-role person. Pure (no db, network or node imports), so the Leads page renders the
// same targets the server will accept (lib/people/work-email.ts re-derives them; nothing the browser sends is trusted).
//
// Who gets the block on a review-lane row: the same rule as a decided lead (not rejected, a company row, settled site, buyer-role
// targets), plus: not a row held because the "company" is a person's handle or the other side of a post (NON_COMPANY_REVIEW as the
// row's CURRENT review reason: there is no company website to ground an address on). Nothing here drafts or sends, and finding an
// address never confirms the lead: it stays in review until the user decides.
import { identityOf } from '../scan/opportunity.ts'
import { companySearchEligible, NON_COMPANY_REVIEW } from '../scan/find-contact-eligible.ts'
import { siteSettled, targetKey, workEmailTargets } from './work-email-eligible.ts'
import type { ContactEnrichment } from './rank.ts'

export interface ReviewLaneLead { id: string; contact: string | null; company?: string | null; quarantined_at?: number | null; source_kind?: string | null; human_confirmed_from?: string | null; review_reason?: string | null; enrichments?: (ContactEnrichment & { connector: string })[] }
export function reviewLaneWorkEmailTargets(l: ReviewLaneLead, buyerRoles: string, nowMs: number = Date.now()): { key: string; name: string; title: string | null }[] {
  if (l.quarantined_at || !companySearchEligible(l) || NON_COMPANY_REVIEW.includes(l.review_reason ?? '')) return []
  const rows = l.enrichments ?? []
  const site = identityOf({ id: l.id, contact: l.contact }, rows)
  if (!siteSettled(site)) return []
  return workEmailTargets(rows, buyerRoles, nowMs, site).map(p => ({ key: targetKey(p), name: p.name, title: p.title }))
}
