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
  enrichments?: { connector: string; kind: string; value: string; label?: string|null; source_url?:string|null }[]
}

// Inboxes whose purpose is not receiving sales outreach, however public they are.
const NON_SALES = new Set(['press', 'media', 'support', 'help', 'privacy', 'security', 'legal', 'abuse', 'careers', 'jobs', 'talent', 'people', 'recruiting', 'hr', 'dpo'])

export type ContactPurpose = 'sales' | 'non-sales' | 'unknown'

export interface PublishedContact { email: string; purpose: ContactPurpose; purposeHint: string | null; source: 'lead' | 'sitecrawl' }

export function classifyPurpose(email: string, context?: ContactContext | null): { purpose: ContactPurpose; hint: string | null } {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  const first = local.split(/[.+_\-]/).filter(Boolean)[0] ?? ''
  const restriction=contextRestriction(context)
  if(NON_SALES.has(first)||restriction)return {purpose:'non-sales',hint:restriction??first}
  const positive=context?.excerpt && /\b(sales (inquir|enquir)|business (inquir|enquir)|partnership (inquir|enquir))/.test(context.excerpt.toLowerCase())
  return {purpose:positive?'sales':'unknown',hint:positive?'business inquiry context':'purpose not established'}
}

export function publishedContact(lead: PublishedEmailLead): PublishedContact | null {
  const primary = address(lead.contact)
  if (PUBLISHED_EMAIL_RE.test(primary)) {
    const c = classifyPurpose(primary, lead.contact_context ?? {excerpt:lead.evidence_excerpt??'',source_url:lead.source_url??''})
    return { email: primary, purpose: c.purpose, purposeHint: c.hint, source: 'lead' }
  }
  const e = (lead.enrichments ?? []).find(x => x.connector === 'sitecrawl' && x.kind === 'email' && PUBLISHED_EMAIL_RE.test(address(x.value)))
  if (!e) return null
  const email = address(e.value)
  if (!PUBLISHED_EMAIL_RE.test(email)) return null
  const c = classifyPurpose(email, readContextLabel(e.label,e.source_url??''))
  return { email, purpose: c.purpose, purposeHint: c.hint, source: 'sitecrawl' }
}

// The only address a sales draft may target. Null means "no usable sales contact",
// never "invent one".
export function publishedEmail(lead: PublishedEmailLead): string | null {
  const c = publishedContact(lead)
  return c && c.purpose !== 'non-sales' ? c.email : null
}

// Why a lead shows no contact. "Not searched" and "searched, nothing published" are different
// facts and must not look alike. Derived only from stored fields: sitecrawl records company_domain
// only after the company's own homepage was fetched and named the company, so a set domain with
// no email means those contact pages were read and no role address of the company was published.
export function contactSearchNote(lead: PublishedEmailLead & { confidence?: number | null; human_confirmed_at?: number | null; company_domain?: string | null }): string | null {
  if (publishedContact(lead)) return null
  if (lead.contact) return null
  if (lead.confidence === null || lead.confidence === undefined) {
    return lead.human_confirmed_at ? 'No contact found. Contact search only runs for leads dazl verified, so it was not run for this one.' : 'No contact found. Contact search only runs for leads dazl verified, so it was not run.'
  }
  if (lead.company_domain) return `No contact published. dazl read ${lead.company_domain} contact pages and found no role address (info@, sales@) on the company's own domain. It never guesses addresses.`
  return 'No contact result recorded. dazl did not confirm the company website, or the contact search did not reach it. That is not proof that no address exists.'
}
