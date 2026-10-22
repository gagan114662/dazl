// The contact a sales draft may use: an address the company itself published -
// on the cited page (lead.contact) or on its own contact/about page (sitecrawl).
// A published address is not automatically a sales contact: press, support,
// privacy and similar inboxes exist for other purposes, and dazl must not aim a
// sales draft at them. createDraft enforces the same rule server-side; these
// helpers keep the UI in exact agreement.
export interface PublishedEmailLead {
  contact: string | null
  enrichments?: { connector: string; kind: string; value: string }[]
}

// Inboxes whose purpose is not receiving sales outreach, however public they are.
const NON_SALES = new Set(['press', 'media', 'support', 'help', 'privacy', 'security', 'legal', 'abuse', 'careers', 'jobs', 'talent', 'people', 'recruiting', 'hr', 'dpo'])

export type ContactPurpose = 'sales' | 'non-sales'

export interface PublishedContact { email: string; purpose: ContactPurpose; purposeHint: string | null; source: 'lead' | 'sitecrawl' }

export function classifyPurpose(email: string): { purpose: ContactPurpose; hint: string | null } {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  const first = local.split(/[.+_\-]/).filter(Boolean)[0] ?? ''
  return NON_SALES.has(first) ? { purpose: 'non-sales', hint: first } : { purpose: 'sales', hint: null }
}

export function publishedContact(lead: PublishedEmailLead): PublishedContact | null {
  if (lead.contact && lead.contact.includes('@')) {
    const c = classifyPurpose(lead.contact)
    return { email: lead.contact, purpose: c.purpose, purposeHint: c.hint, source: 'lead' }
  }
  const e = (lead.enrichments ?? []).find(x => x.connector === 'sitecrawl' && x.kind === 'email' && x.value.includes('@'))
  if (!e) return null
  const c = classifyPurpose(e.value)
  return { email: e.value, purpose: c.purpose, purposeHint: c.hint, source: 'sitecrawl' }
}

// The only address a sales draft may target. Null means "no usable sales contact",
// never "invent one".
export function publishedEmail(lead: PublishedEmailLead): string | null {
  const c = publishedContact(lead)
  return c && c.purpose === 'sales' ? c.email : null
}
