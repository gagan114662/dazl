import { isRecruitingInbox } from '../recruiting-inbox.ts'
import {contextRestriction,readContextLabel,type ContactContext} from './contact-context.ts'
export const PUBLISHED_EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
const address = (value: string | null) => value?.trim().toLowerCase() ?? ''

// The contact a sales draft may use: an address the company itself published -
// on the cited page (lead.contact) or on its own contact/about page (sitecrawl).
// A published address is not automatically a sales contact: press, support,
// privacy and similar inboxes exist for other purposes, and dazl must not aim a
// sales draft at them. createDraft enforces the same rule server-side; these
// helpers keep the UI in exact agreement.
export interface PublishedEmailLead {
  contact: string | null
  source_url?: string
  evidence_excerpt?: string | null
  contact_context?: ContactContext | null
  enrichments?: { connector: string; kind: string; value: string; label?: string|null; source_url?:string|null; retrieved_at?: number|null }[]
}

// Inboxes whose purpose is not receiving sales outreach, however public they are.
const NON_SALES = new Set(['press', 'media', 'support', 'help', 'privacy', 'security', 'legal', 'abuse', 'careers', 'jobs', 'talent', 'people', 'recruiting', 'hr', 'dpo'])

export type ContactPurpose = 'sales' | 'non-sales' | 'unknown'

export type DomainBasisKind = 'cited_page' | 'own_domain' | 'linked' | 'link_text_only' | 'name_probe' | 'unrecorded'
export interface PublishedContact { email: string; purpose: ContactPurpose; purposeHint: string | null; source: 'lead' | 'sitecrawl'; domainBasis: DomainBasisKind; domainBasisSourceUrl: string | null }

// How the company website behind a crawled address was chosen (recorded by the crawler as a 'domain' enrichment
// with the page that produced it). Rows crawled before this was recorded have no such row: 'unrecorded', which is
// neither trusted nor refused here. 'name_probe' and 'link_text_only' mean the homepage merely named the company.
// Strength order, weakest first. The weakest recorded basis for a domain governs: a later stronger row never upgrades it.
const BASIS_RANK: { [token: string]: { kind: DomainBasisKind; rank: number } } = {
  name_probe: { kind: 'name_probe', rank: 1 },
  evidence_link_text: { kind: 'link_text_only', rank: 2 },
  evidence_link_domain_label: { kind: 'linked', rank: 3 },
  evidence_own_domain: { kind: 'own_domain', rank: 4 },
}
const parseDomainRow = (x: { value: string; label?: string | null }) => {
  const [domain, token = ''] = x.value.toLowerCase().split('|')
  const t = (x.label ?? '').startsWith('domain-basis-v1:') ? (x.label ?? '').slice('domain-basis-v1:'.length) : ''
  return { domain, basis: t === token ? BASIS_RANK[t] : undefined }
}
export function domainBasisFor(email: string, enrichments: PublishedEmailLead['enrichments']): { kind: DomainBasisKind; url: string | null; domain: string } {
  const host = (email.split('@')[1] ?? '').toLowerCase()
  const rows = (enrichments ?? [])
    .filter(x => x.connector === 'sitecrawl' && x.kind === 'domain')
    .map(x => ({ x, ...parseDomainRow(x) }))
    .filter(r => !!r.domain && (host === r.domain || host.endsWith('.' + r.domain)))
  if (rows.length === 0) return { kind: 'unrecorded', url: null, domain: host }
  const best = Math.max(...rows.map(r => r.domain.length))
  const rs = rows.filter(r => r.domain.length === best)
  // An unreadable token counts as unrecorded and beats every readable one (weakest governs).
  const unknown = rs.find(r => !r.basis)
  if (unknown) return { kind: 'unrecorded', url: unknown.x.source_url ?? null, domain: unknown.domain }
  const w = rs.reduce((m, r) => (r.basis!.rank < m.basis!.rank ? r : m))
  return { kind: w.basis!.kind, url: w.x.source_url ?? null, domain: w.domain }
}
// The crawled address a draft would use. One rule for the UI and for createDraft: newest retrieved first.
export function pickCrawledEmail<T extends { connector: string; kind: string; value: string; retrieved_at?: number | null }>(enrichments: T[] | undefined): T | null {
  const c = (enrichments ?? []).filter(x => x.connector === 'sitecrawl' && x.kind === 'email' && PUBLISHED_EMAIL_RE.test(address(x.value)))
  return c.map((x, i) => ({ x, i })).sort((p, q) => (q.x.retrieved_at ?? 0) - (p.x.retrieved_at ?? 0) || p.i - q.i)[0]?.x ?? null
}
export function domainBasisText(e: { value: string; label?: string | null }): string {
  const b = parseDomainRow(e).basis?.kind
  return b === 'name_probe' ? 'website guessed from the company name; the homepage read names the company' : b === 'link_text_only' ? 'linked from the cited page by link text only; homepage names the company' : b === 'linked' ? 'linked from the cited page, domain name matches; homepage names the company' : b === 'own_domain' ? 'the cited page is on this domain; homepage names the company' : 'how this website was chosen was not recorded'
}
export const domainBasisUnconfirmed = (k: DomainBasisKind) => k === 'name_probe' || k === 'link_text_only'
export function domainBasisNote(c: PublishedContact): string | null {
  switch (c.domainBasis) {
    case 'name_probe': return 'Website guessed from the company name; the homepage that was read names the company.'
    case 'link_text_only': return 'Website linked from the cited page by link text only; its homepage names the company.'
    case 'linked': return 'Website linked from the cited page, domain name matches the company; this is not proof the site is theirs.'
    case 'unrecorded': return c.source === 'sitecrawl' ? 'How this website was chosen was not recorded.' : null
    default: return null
  }
}

export function classifyPurpose(email: string, context?: ContactContext | null): { purpose: ContactPurpose; hint: string | null } {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  const first = local.split(/[.+_\-]/).filter(Boolean)[0] ?? ''
  const restriction=contextRestriction(context)
  if(isRecruitingInbox(email)||NON_SALES.has(first)||restriction)return {purpose:'non-sales',hint:restriction??first}
  const positive=context?.excerpt && /\b(sales (inquir|enquir)|business (inquir|enquir)|partnership (inquir|enquir))/.test(context.excerpt.toLowerCase())
  return {purpose:positive?'sales':'unknown',hint:positive?'business inquiry context':'purpose not established'}
}

export function publishedContact(lead: PublishedEmailLead): PublishedContact | null {
  const primary = address(lead.contact)
  if (PUBLISHED_EMAIL_RE.test(primary)) {
    const c = classifyPurpose(primary, lead.contact_context ?? {excerpt:lead.evidence_excerpt??'',source_url:lead.source_url??''})
    return { email: primary, purpose: c.purpose, purposeHint: c.hint, source: 'lead', domainBasis: 'cited_page', domainBasisSourceUrl: lead.source_url ?? null }
  }
  const e = pickCrawledEmail(lead.enrichments)
  if (!e) return null
  const email = address(e.value)
  if (!PUBLISHED_EMAIL_RE.test(email)) return null
  const c = classifyPurpose(email, readContextLabel(e.label,e.source_url??''))
  const b = domainBasisFor(email, lead.enrichments)
  return { email, purpose: c.purpose, purposeHint: c.hint, source: 'sitecrawl', domainBasis: b.kind, domainBasisSourceUrl: b.url }
}

// The only address a sales draft may target. Null means "no usable sales contact",
// never "invent one".
export function publishedEmail(lead: PublishedEmailLead): string | null {
  const c = publishedContact(lead)
  return c && c.purpose !== 'non-sales' ? c.email : null
}

// Why a lead shows no contact. Eligibility and storage facts only: sitecrawl runs for dazl-verified
// leads (top 8 per scan), and company_domain is recorded once the company homepage named the company.
// Neither proves the contact pages were fully read or that no address exists, so no copy claims that.
export function contactSearchNote(lead: PublishedEmailLead & { confidence?: number | null; human_confirmed_at?: number | null; company_domain?: string | null }): string | null {
  if (publishedContact(lead)) return null
  if (lead.contact) return null
  if ((lead.confidence === null || lead.confidence === undefined) && lead.human_confirmed_at) return 'No contact stored. Automatic contact search only runs for machine-verified leads; you can ask dazl to look on the company website below.'
  if (lead.confidence === null || lead.confidence === undefined) return 'No contact stored. Contact search only runs for machine-verified leads; this lead is not machine-verified.'
  if (lead.company_domain) return `No published contact stored. Company website identified: ${lead.company_domain}. This does not prove no address exists.`
  return 'No published contact stored. Company website not confirmed. This does not prove no address exists.'
}
