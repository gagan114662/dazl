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
  if (urlIdentity(r.source_url) !== ld) return false
  return r.kind !== 'email' || emailIdentity(r.value) === ld
}
export const isFounderRoute = (r: SiteRow): boolean =>
  r.kind === 'phone' || (r.kind === 'email' && emailIdentity(r.value) !== null && !isRecruitingInbox(r.value) && !NOT_A_FOUNDER_ROUTE.test(r.value.trim().split('@')[0].replace(/[._-]/g, '')))

export interface SiteContact { confirmed: boolean; domain: string | null; person: SiteRow | null; route: SiteRow | null }
const ROWS_SQL = "SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind IN ('person', 'phone', 'email')"
// The lead's current confirmed domain, role-matching person and published route, from the rows as they are now. Pass `rows` to
// reuse rows already read under the same tenant; they are filtered here either way.
export function currentSiteContact(db: Database.Database, tenantId: string, lead: { id: string; company_domain: string | null }, who: string, rows?: SiteRow[]): SiteContact {
  const confirmed = !!lead.company_domain && domainConfirmed(db, tenantId, lead.id, lead.company_domain)
  const ld = confirmed ? siteIdentity(lead.company_domain) : null
  if (!ld) return { confirmed, domain: null, person: null, route: null }
  const own = (rows ?? db.prepare(ROWS_SQL).all(lead.id, tenantId) as SiteRow[]).filter(r => onCompanySite(r, ld))
  return {
    confirmed, domain: ld,
    person: own.find(r => r.kind === 'person' && personMatchesRole(r.value, who || 'founder')) ?? null,
    route: own.find(isFounderRoute) ?? null,
  }
}
