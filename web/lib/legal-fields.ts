// Terms of Service and Privacy Policy: which fields are still missing before the pages can be called final. This module
// only INVENTORIES and VALIDATES. It writes no legal text, supplies no value for any field, and never marks a page final:
// the owner and counsel decide every value. A page is "final" only when it has no bracketed placeholder and no DRAFT banner.
export type LegalPage = 'terms' | 'privacy'
export interface LegalField {
  page: LegalPage; token: string      // the exact bracketed placeholder as it appears in the page
  name: string; needs: string         // what the field is, and what has to be supplied
  owner: 'site owner' | 'counsel'     // who decides the value
}
// The required missing fields as of this inventory. test/legal-fields.test.ts fails when a page gains or loses a placeholder
// without this list changing, so the list cannot go stale.
export const LEGAL_FIELDS: LegalField[] = [
  { page: 'terms', token: '[DATE]', name: 'Last-updated date', needs: 'the date the final terms take effect', owner: 'site owner' },
  { page: 'terms', token: '[COMPANY LEGAL NAME]', name: 'Contracting entity', needs: 'the legal name of the company users contract with', owner: 'site owner' },
  { page: 'terms', token: '[PLANS AND PRICING WHEN PAID PLANS LAUNCH]', name: 'Billing terms', needs: 'plans, prices and billing terms (must match what checkout actually charges)', owner: 'site owner' },
  { page: 'terms', token: '[LIABILITY, WARRANTY, TERMINATION, GOVERNING LAW - TO BE WRITTEN BY COUNSEL]', name: 'Liability, warranty, termination and governing law', needs: 'clauses written by counsel', owner: 'counsel' },
  { page: 'privacy', token: '[DATE]', name: 'Last-updated date', needs: 'the date the final policy takes effect', owner: 'site owner' },
  { page: 'privacy', token: '[COMPANY LEGAL NAME]', name: 'Operating entity', needs: 'the legal name of the company that operates the service', owner: 'site owner' },
  { page: 'privacy', token: '[LIST]', name: 'Service providers', needs: 'the actual list of hosting, email, payment and other providers that process personal data', owner: 'site owner' },
  { page: 'privacy', token: '[PRIVACY EMAIL]', name: 'Privacy contact', needs: 'a monitored address for access, correction, deletion and stop requests', owner: 'site owner' },
  { page: 'privacy', token: '[CONFIRM CASL / CAN-SPAM COMPLIANCE WITH COUNSEL]', name: 'Outbound email compliance statement', needs: "counsel's confirmed wording for the sender identification, postal address and unsubscribe statement", owner: 'counsel' },
]
export const DRAFT_BANNER = /DRAFT\s*-\s*placeholder text/i
const PLACEHOLDER = /\[[A-Z][A-Z0-9 ,/&.\-]*\]/g

export interface LegalReport { page: LegalPage; draftBanner: boolean; placeholders: string[]; missing: LegalField[]; unlisted: string[]; final: boolean }
// source: the page file's text. unlisted = a placeholder the inventory does not know about (the inventory needs updating).
export function legalReport(page: LegalPage, source: string): LegalReport {
  const found = [...new Set(source.match(PLACEHOLDER) ?? [])]
  const known = LEGAL_FIELDS.filter(f => f.page === page)
  const missing = known.filter(f => found.includes(f.token))
  const unlisted = found.filter(t => !known.some(f => f.token === t))
  const draftBanner = DRAFT_BANNER.test(source)
  return { page, draftBanner, placeholders: found, missing, unlisted, final: !draftBanner && found.length === 0 }
}
