// Apollo.io via the tenant's OWN key (BYOK). No operator-paid lookups: without a key
// nothing calls Apollo. Credit discipline per Apollo's current docs:
//   mixed_people/api_search - 0 credits, returns people WITHOUT emails/phones
//   organizations/enrich    - 1 credit per organization
// So this client only ever calls those two endpoints, keeps names/titles/firmographics,
// and drops any email/phone field even if a paid key returns one (dazl's contact rule
// is company-published contacts, not brokered personal data).
// Docs: https://docs.apollo.io/reference/people-api-search , /docs/api-pricing

export class EnrichError extends Error {
  code: 'rate_limited' | 'auth' | 'upstream'
  constructor(code: 'rate_limited' | 'auth' | 'upstream', msg: string) { super(msg); this.code = code }
}

const BASE = 'https://api.apollo.io'
const TIMEOUT_MS = 15_000

export interface ApolloOrg { name: string | null; employees: number | null; industry: string | null; founded: number | null; website: string | null; linkedin: string | null; place: string | null; address?: string | null }
export interface ApolloPerson { name: string; title: string | null; linkedin: string | null; recordDay?: string | null; place?: string | null; address?: string | null; domain?: string | null; organization?: { name: string | null; domain: string | null } | null } // organization: the company the RESULT says the person works for (kept so a contradicting one can be refused)

async function call(apiKey: string, path: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'cache-control': 'no-cache' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (r.status === 429) throw new EnrichError('rate_limited', 'Apollo rate limit reached')
    if (r.status === 401 || r.status === 403) throw new EnrichError('auth', 'Apollo rejected the key')
    if (!r.ok) throw new EnrichError('upstream', `Apollo returned ${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

import { formatPlace } from '../scan/contact-agreement.ts'
import { isMailboxShaped } from './person-name.ts'
import { latestDay } from '../people/currency.ts'
const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : null)

// 1 credit per call.
export async function apolloOrgEnrich(apiKey: string, org: { domain?: string | null; name?: string | null }, fetchImpl: typeof fetch = fetch): Promise<ApolloOrg | null> {
  const body: Record<string, unknown> = {}
  if (org.domain) body.domain = org.domain
  else if (org.name) body.name = org.name
  else return null
  const j = await call(apiKey, '/api/v1/organizations/enrich', body, fetchImpl) as { organization?: Record<string, unknown> }
  const o = j.organization
  if (!o) return null
  return {
    name: clean(o.name),
    employees: typeof o.estimated_num_employees === 'number' ? o.estimated_num_employees : null,
    industry: clean(o.industry, 120),
    founded: typeof o.founded_year === 'number' ? o.founded_year : null,
    website: clean(o.website_url),
    linkedin: clean(o.linkedin_url),
    place: formatPlace(clean(o.city, 80), clean(o.state, 80), clean(o.country, 80)),
    address: clean(o.street_address, 120) ?? clean(o.raw_address, 160),
  }
}

function orgOf(p: Record<string, unknown>): { name: string | null; domain: string | null } | null {
  const o = (p.organization && typeof p.organization === 'object' ? p.organization : null) as Record<string, unknown> | null
  const name = clean(o?.name ?? p.organization_name, 160)
  const raw = clean(o?.primary_domain ?? o?.website_url ?? o?.domain, 200)
  const domain = raw ? raw.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '') || null : null
  return name || domain ? { name, domain } : null
}

// 0 credits. People come back with no emails/phones; we strip them even if present.
// `role`: the reviewed buyer persona (the scan ICP's who list) as titles, sent BEFORE the page cap so a
// buyer beyond the first unfiltered page is still returned (#383). Only what the tenant reviewed goes
// into the query: seniorities/functions are never invented from title words (a wrong derived seniority
// would exclude the very buyer the filter exists to find).
export async function apolloPeopleSearch(apiKey: string, org: { domain?: string | null; name: string }, fetchImpl: typeof fetch = fetch, max = 5, role?: { titles: string[] }): Promise<ApolloPerson[]> {
  const body: Record<string, unknown> = { per_page: max, page: 1 }
  const titles = (role?.titles ?? []).map(t => t.trim()).filter(Boolean).slice(0, 10)
  if (titles.length) body.person_titles = titles
  if (org.domain) body.q_organization_domains = org.domain
  else body.q_organization_name = org.name
  const j = await call(apiKey, '/api/v1/mixed_people/api_search', body, fetchImpl) as { people?: Record<string, unknown>[] }
  // Filter mailbox/team labels BEFORE the cap so department-labelled rows cannot displace real people within max.
  return (j.people ?? []).map(p => ({
    name: clean(p.name, 120) ?? '',
    title: clean(p.title, 120),
    linkedin: clean(p.linkedin_url),
    organization: orgOf(p),
    // The provider record's own last-refreshed / updated date (#383 criterion 4: verified current within 90 days). Kept
    // only as a strict YYYY-MM-DD; any other shape is null, so the contact stays search-result-only.
    recordDay: latestDay(p.last_refreshed_at, p.updated_at),
    // p.email / p.phone_numbers deliberately never read
  })).filter(p => p.name && !isMailboxShaped(p.name)).slice(0, max)
}
