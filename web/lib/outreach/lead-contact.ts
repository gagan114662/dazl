// #384: what a lead's contact line may claim. Three separate facts, never inferred from one another:
//   provenance     - where the address was published (the cited page, the company's own page, or not recorded)
//   deliverability - whether the mailbox works: 'unknown' unless a check was actually run (a page that prints an address does not make it deliverable)
//   route          - whether the address is the recommended person's ('person': it spells their name or the page names them) or just a company inbox ('company')
// A generic address (hello@, info@, contact@) is a company inbox: it is never shown as reaching the named decision-maker. The published-only policy is unchanged; this only describes addresses.
import { publishedContact, type PublishedEmailLead } from './published-email.ts'
import { contactState, type DomainCheck, type Deliverability } from './contact-state.ts'

export type RouteKind = 'person' | 'company'
export interface LeadContactFacts {
  email: string
  provenance: string                   // "printed on the cited page", "listed on the company's own website", "source not recorded"
  deliverability: Deliverability
  deliverabilityText: string
  route: RouteKind
  routeText: string
  text: string                         // one line: provenance; deliverability; route
}
const DELIVERABILITY_TEXT: Record<Deliverability, string> = { valid: 'mailbox check passed', invalid: 'mailbox check failed', catch_all: 'domain accepts any address; mailbox not proven', unknown: 'deliverability not checked' }

export function leadContactFacts(lead: PublishedEmailLead, person: { name: string } | null, opt: { check?: DomainCheck | null; now?: number } = {}): LeadContactFacts | null {
  const pc = publishedContact(lead)
  if (!pc || pc.purpose === 'non-sales') return null
  const sourceUrl = pc.source === 'lead' ? lead.source_url ?? null : pc.domainBasisSourceUrl
  const st = contactState({ email: pc.email, person, published: sourceUrl ? { sourceUrl, excerpt: pc.source === 'lead' ? lead.evidence_excerpt : null } : null, check: opt.check ?? null }, opt.now ?? Math.floor(Date.now() / 1000))
  const provenance = pc.source === 'lead' ? 'printed on the cited page' : sourceUrl ? "listed on the company's own website" : 'source not recorded'
  const route: RouteKind = st.personBound === 'yes' && person ? 'person' : 'company'
  const routeText = route === 'person' && person ? `spells or is next to ${person.name}'s name` : person ? `company inbox, not tied to ${person.name}` : 'company inbox, not tied to a named person'
  return { email: pc.email, provenance, deliverability: st.deliverability, deliverabilityText: DELIVERABILITY_TEXT[st.deliverability], route, routeText, text: `${provenance}; ${DELIVERABILITY_TEXT[st.deliverability]}; ${routeText}` }
}
