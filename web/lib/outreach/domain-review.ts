import { createHash } from 'node:crypto'
import { PUBLISHED_EMAIL_RE, domainBasisFor, pickCrawledEmail, type DomainBasisKind, type PublishedEmailLead } from './published-email.ts'

// Identity review for a crawled address. Pure (no db, no network) so the server gate and the page apply one rule.
// It answers one question only: did the user check that the website behind a crawled address belongs to the company?
// It is not a statement of need, not consent, not a send approval, and it does not touch the purpose,
// legal or send guards. Review rows are written with connector 'user' and read only under the tenant filter.
export const REVIEW_PREFIX = 'domain-review-v1:'
export type ReviewState = 'not_required' | 'required' | 'confirmed'
export interface Covered { domains: { domain: string; source_url: string | null }[]; addresses: { email: string; source_url: string | null }[] }
// covered is everything one confirmation covers (every recorded website and every crawled address, each with its page). When more than one
// website or address is recorded the binding is version 2 and covers that full set, so a confirmation made when the user was shown only one
// of them no longer matches. A single website with a single address keeps the version 1 binding, so an earlier review of exactly that stands.
export interface ReviewDecision { state: ReviewState; domain: string | null; basis: DomainBasisKind | null; basisSourceUrl: string | null; email: string | null; binding: string | null; covered?: Covered; multi?: boolean }

type Row = NonNullable<PublishedEmailLead['enrichments']>[number]

// Only an address printed on the cited page itself, or one on a domain that the cited page itself is hosted on, needs no review.
// A link, a link label, a name probe and an unrecorded choice each rest on the company name matching, which is not ownership.
const NO_REVIEW: DomainBasisKind[] = ['own_domain']

export function domainReviewFor(lead: { id: string; contact?: string | null }, enrichments: Row[] | undefined): ReviewDecision {
  const none: ReviewDecision = { state: 'not_required', domain: null, basis: null, basisSourceUrl: null, email: null, binding: null }
  const e = pickCrawledEmail(enrichments)
  // A contact email is a cited-page address and needs no review, unless it is the very address the crawl recorded: then the
  // crawl is its only recorded origin, equality with the contact does not prove the cited page printed it, and the review applies.
  const contact = (lead.contact ?? '').trim().toLowerCase()
  if (PUBLISHED_EMAIL_RE.test(contact) && (!e || e.value.trim().toLowerCase() !== contact)) return none
  if (!e) return none
  const email = e.value.trim().toLowerCase()
  const b = domainBasisFor(email, enrichments)
  const allDomains = (enrichments ?? []).filter(x => x.connector === 'sitecrawl' && x.kind === 'domain').map(x => `${x.value.toLowerCase()}@${x.source_url ?? ''}`).sort()
  // The binding covers the lead, the domain, how it was chosen and from which page, the exact address and the page showing it,
  // and every domain the crawler has recorded for the lead. A change in any of them leaves an old review unmatched.
  const domainsOnly = new Set((enrichments ?? []).filter(x => x.connector === 'sitecrawl' && x.kind === 'domain').map(x => x.value.toLowerCase().split('|')[0]))
  const addrs = [...new Map((enrichments ?? []).filter(x => x.connector === 'sitecrawl' && x.kind === 'email' && PUBLISHED_EMAIL_RE.test(x.value.trim().toLowerCase())).map(x => [`${x.value.trim().toLowerCase()}@${x.source_url ?? ''}`, { email: x.value.trim().toLowerCase(), source_url: x.source_url ?? null }])).values()].sort((p, q) => (p.email + (p.source_url ?? '')).localeCompare(q.email + (q.source_url ?? '')))
  const doms = [...new Map((enrichments ?? []).filter(x => x.connector === 'sitecrawl' && x.kind === 'domain').map(x => [`${x.value.toLowerCase().split('|')[0]}@${x.source_url ?? ''}`, { domain: x.value.toLowerCase().split('|')[0], source_url: x.source_url ?? null }])).values()].sort((p, q) => (p.domain + (p.source_url ?? '')).localeCompare(q.domain + (q.source_url ?? '')))
  const multi = domainsOnly.size > 1 || new Set(addrs.map(a => a.email)).size > 1
  const binding = createHash('sha256').update(JSON.stringify(multi ? ['v2', lead.id, b.domain, b.kind, b.url, email, e.source_url ?? null, allDomains, addrs.map(a => `${a.email}@${a.source_url ?? ''}`)] : ['v1', lead.id, b.domain, b.kind, b.url, email, e.source_url ?? null, allDomains])).digest('hex')
  const base = { domain: b.domain, basis: b.kind, basisSourceUrl: b.url, email, binding, covered: { domains: doms, addresses: addrs }, multi }
  if (NO_REVIEW.includes(b.kind) && domainsOnly.size <= 1) return { state: 'not_required', ...base }
  const ok = (enrichments ?? []).some(x => x.connector === 'user' && x.kind === 'domain_review' && x.value.toLowerCase() === b.domain && x.label === REVIEW_PREFIX + binding)
  return { state: ok ? 'confirmed' : 'required', ...base }
}
