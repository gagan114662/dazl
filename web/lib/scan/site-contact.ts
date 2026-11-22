// One rule for "the company's own named person and published route", read from the CURRENT evidence (#914). Actionability
// (lib/scan/actionable.ts), the machine timing proof (lib/scan/timing-proof.ts) and the completion score read it, so none of them
// trusts an earlier pass's summary or assumes the contact-source enforcement (contact-agreement.ts enforceContactSource) succeeded:
//   - the lead's company domain is CONFIRMED (signals/domain-basis.ts domainConfirmed: own-domain evidence, a current user review,
//     or a passed homepage domain check). A populated company_domain alone is a guess;
//   - a site contact counts only while its source page is on that confirmed domain and, for an email, the address is at it;
//   - the person is named with a founder-level title or the requested role; the route is a phone or a mailbox that is not a
//     support / privacy / legal / careers / press ... inbox.
// Domain identity is public-suffix aware (tldts via verifier/text.ts registrable): alpha.co.uk and unrelated.co.uk are different
// companies, shop.acme.example and acme.example are the same one.
import type Database from 'better-sqlite3'
import { titleMatches } from '../people/rank.ts'
import { isRecruitingInbox } from '../recruiting-inbox.ts'
import { domainConfirmed } from '../signals/domain-basis.ts'
import { registrable } from '../verifier/text.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'
// #1122: a person on the company's LinkedIn People page, read in the user's own browser. Written only for a lead whose CONFIRMED site
// links that one LinkedIn company page (lib/linkedin-tasks/buyers.ts); the source is the person's own LinkedIn profile.
export const LINKEDIN_PEOPLE_LABEL = "listed on the company's LinkedIn page"
const LINKEDIN_PROFILE = /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9%_-]{2,100}\/$/
export const OWN_POSTING_PERSON_LABEL = "named in this company's own job posting (\"Reports to\"), not verified as current staff"

// Mailboxes that are not a way to reach a founder: support, privacy, legal, careers, recruiting, press, abuse, no-reply, billing.
export const NOT_A_FOUNDER_ROUTE = /^(?:support|help|privacy|legal|dpo|security|abuse|careers?|jobs?|recruit\w*|hiring|talent|hr|people|press|media|pr|billing|accounts?|invoices?|noreply|no-reply|donotreply|webmaster|postmaster|compliance|gdpr)$/i
const FOUNDER = /\b(?:founder|co-?founder|ceo|chief executive|managing director|owner|president)\b/i
// A named person counts as the contact only when the title is a founder-level role or matches the role the request asked for.
export const personMatchesRole = (value: string, who: string): boolean => { const t = value.split(',').slice(1).join(',').trim(); return FOUNDER.test(t) || titleMatches(t, who).length > 0 }
export const whoOf = (icp: string | null | undefined): string => { try { const j = icp ? JSON.parse(icp) as { who?: unknown } : null; return Array.isArray(j?.who) ? j!.who.filter((x): x is string => typeof x === 'string').join(' ') : '' } catch { return '' } }

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
// The registrable company identity of a bare host or domain value (www., scheme and path stripped). Malformed input is null.
export function siteIdentity(hostOrDomain: string | null | undefined): string | null {
  const h = (hostOrDomain ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '')
  if (!HOST.test(h)) return null
  const r = registrable(h)
  return r && HOST.test(r) ? r : null
}
const urlIdentity = (u: string | null | undefined): string | null => { try { return siteIdentity(new URL(u ?? '').hostname) } catch { return null } }
const EMAIL = /^[a-z0-9._%+-]+@([a-z0-9.-]+)$/i
// The identity of a well-formed address's domain; a malformed address is null.
export const emailIdentity = (v: string | null | undefined): string | null => { const m = EMAIL.exec((v ?? '').trim()); return m ? siteIdentity(m[1]) : null }

export interface SiteRow { connector: string; kind: string; value: string; source_url: string | null; label?: string | null }
// Is this sitecrawl contact row from the company's own (confirmed) site? ld = siteIdentity of the confirmed company domain.
export function onCompanySite(r: SiteRow, ld: string | null): boolean {
  if (!ld || r.connector !== 'sitecrawl') return false
  // Run 679a7354: a person named in the lead's own ATS posting (written only by sitecrawl, from the lead's own source record) beside the confirmed domain
  // ...and only when that posting is THIS company's own board: its org token is the confirmed domain's name (Qodo #1513 a)
  if (r.kind === 'person' && r.label === LINKEDIN_PEOPLE_LABEL) return LINKEDIN_PROFILE.test(r.source_url ?? '')
  if (r.kind === 'person' && r.label === OWN_POSTING_PERSON_LABEL) { const ref = atsPostingRef(r.source_url ?? ''); return !!ref && postingOrgIs(ref.org, ld) }
  if (urlIdentity(r.source_url) !== ld) return false
  return r.kind !== 'email' || emailIdentity(r.value) === ld
}
export const isFounderRoute = (r: SiteRow): boolean =>
  r.kind === 'phone' || (r.kind === 'email' && emailIdentity(r.value) !== null && !isRecruitingInbox(r.value) && !NOT_A_FOUNDER_ROUTE.test(r.value.trim().split('@')[0].replace(/[._-]/g, '')))

const canonical = (a: SiteRow, b: SiteRow): number => cmp(a.kind, b.kind) || cmp(a.value, b.value) || cmp(a.source_url ?? '', b.source_url ?? '') || cmp(a.label ?? '', b.label ?? '')
const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0)
// PM call (#1513): for a Head of Sales request, a person named in the company's own posting with its top sales title ((S)VP / EVP of Sales,
// CRO) is that buyer. Posting rows only; a site-listed person keeps personMatchesRole as it is.
const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
// The posting's board org names this registrable domain's company: "HowGood" for howgood.com. Never a partial or fuzzy match.
export const postingOrgIs = (org: string, ld: string): boolean => { const label = ld.split('.')[0]; return !!label && alnum(org) === alnum(label) }
// "Head of Sales" as the whole requested role, not the start of a longer one ("Head of Sales Operations"; Qodo #1513 b)
const HEAD_OF_SALES = /\bhead\s+of\s+sales\b(?!\s+(?!or\b|and\b)[a-z])/i
export const postingTopSales = (value: string, who: string): boolean => HEAD_OF_SALES.test(who) &&
  /^(?:(?:Senior|Executive)\s+)?(?:S?VP|EVP|Vice\s+President)\s+(?:of\s+)?Sales$|^(?:CRO|Chief\s+Revenue\s+Officer)$/i.test(value.split(',').slice(1).join(',').trim())
// A posting-named person (Qodo #1513 b) takes the posting reader's own bar, not the looser one-shared-word rule: a founder-level title,
// two or more of the requested role's words, or the top-sales reading for an exact Head of Sales request.
export const postingPersonMatches = (value: string, who: string): boolean => { const t = value.split(',').slice(1).join(',').trim(); return FOUNDER.test(t) || titleMatches(t, who).length >= 2 || postingTopSales(value, who) }
export interface SiteContact { confirmed: boolean; domain: string | null; person: SiteRow | null; route: SiteRow | null }
const ROWS_SQL = "SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind IN ('person', 'phone', 'email')"
// The lead's current confirmed domain, role-matching person and published route, from the rows as they are now. Pass `rows` to
// reuse rows already read under the same tenant; they are filtered here either way.
export function currentSiteContact(db: Database.Database, tenantId: string, lead: { id: string; company_domain: string | null }, who: string, rows?: SiteRow[]): SiteContact {
  const confirmed = !!lead.company_domain && domainConfirmed(db, tenantId, lead.id, lead.company_domain)
  return siteContactFromRows(lead.company_domain, confirmed, who,
    confirmed && siteIdentity(lead.company_domain) ? rows ?? db.prepare(ROWS_SQL).all(lead.id, tenantId) as SiteRow[] : [])
}

export function siteContactFromRows(domain:string|null,confirmed:boolean,who:string,rows:SiteRow[]):SiteContact {
  const ld = confirmed ? siteIdentity(domain) : null
  if (!ld) return { confirmed, domain: null, person: null, route: null }
  // Canonical order (not DB return order): the timing proof hashes the chosen person/route, so the same rows must always pick the same
  // contact whatever the engine, query plan or copy returns first (#943 review). Source, kind, value, label are all stable text.
  const own = rows.filter(r => onCompanySite(r, ld)).sort(canonical)
  return {
    confirmed, domain: ld,
    person: own.find(r => r.kind === 'person' && (r.label === OWN_POSTING_PERSON_LABEL ? postingPersonMatches(r.value, who || 'founder') : personMatchesRole(r.value, who || 'founder'))) ?? null,
    route: own.find(isFounderRoute) ?? null,
  }
}
