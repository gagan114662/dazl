// Apollo.io via the tenant's OWN key (BYOK). No operator-paid lookups: without a key
// nothing calls Apollo. Credit discipline per Apollo's current docs:
//   mixed_people/api_search - 0 credits, returns people WITHOUT emails/phones
//   organizations/enrich    - 1 credit per organization
// So this client only ever calls those two endpoints, keeps names/titles/firmographics,
// and drops any email/phone field even if a paid key returns one (dazl's contact rule
// is company-published contacts, not brokered personal data). The one exception is apolloPersonMatch below (#1036):
// a lookup the user clicks, on the user's own key, that keeps a work email only with Apollo's own status label.
// Docs: https://docs.apollo.io/reference/people-api-search , /docs/api-pricing

export class EnrichError extends Error {
  code: 'rate_limited' | 'auth' | 'upstream'
  constructor(code: 'rate_limited' | 'auth' | 'upstream', msg: string) { super(msg); this.code = code }
}

const BASE = 'https://api.apollo.io'
import { reserveScanSpend, unitCostUsd } from '../scan/spend-cap.ts'
import { isStaging } from '../staging.ts'
// The paid lookup request is given up on after this; exported for the stale-running lease floor (lib/scan/store.ts).
export const APOLLO_TIMEOUT_MS = 15_000
const TIMEOUT_MS = APOLLO_TIMEOUT_MS

export interface ApolloOrg { name: string | null; employees: number | null; industry: string | null; founded: number | null; website: string | null; linkedin: string | null; place: string | null; address?: string | null }
export interface ApolloPerson { name: string; title: string | null; linkedin: string | null; recordDay?: string | null; place?: string | null; address?: string | null; domain?: string | null; organization?: { name: string | null; domain: string | null } | null } // organization: the company the RESULT says the person works for (kept so a contradicting one can be refused)

async function call(apiKey: string, path: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<unknown> {
  // Inside a scan: reserved on the scan's spend cap first (lib/scan/spend-cap.ts); a refusal (SpendRefused) sends nothing.
  const kind = path.startsWith('/api/v1/organizations/') ? 'apollo.org' : 'apollo.people'
  const hold = await reserveScanSpend(kind, () => unitCostUsd(kind, 1))
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    let r: Response
    try {
      r = await fetchImpl(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'cache-control': 'no-cache' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (e) { hold?.uncertain(); throw e } // timeout / dropped connection after send: may have been billed, the row stays 'reserved' and the attempt stops paying (#363)
    if (hold) { if (r.ok || [400, 401, 403, 404, 413, 429].includes(r.status)) { await hold.settle(r.ok ? hold.usd : null); if (!r.ok) hold.rejected(r.status) } else hold.uncertain() } // a documented rejection is counted (kept) but never claimed uncharged; any other status: maybe billed
    if (r.status === 429) throw new EnrichError('rate_limited', 'Apollo rate limit reached')
    if (r.status === 401 || r.status === 403) throw new EnrichError('auth', 'Apollo rejected the key')
    if (!r.ok) throw new EnrichError('upstream', `Apollo returned ${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

import { formatPlace } from '../scan/contact-agreement.ts'
import { isMailboxShaped } from './person-name.ts'
import { latestDay } from '../people/currency.ts'

// #383 TEST-ONLY staging fixture (Hermes-PC 2026-11-13: criteria 1-2 need a test-only Apollo answer on staging, same pattern as the
// #1131 fake PDL). Active ONLY when DAZL_ENV=staging AND DAZL_STAGING_FAKE_APOLLO=1; inert everywhere else (production never
// reads the flag). It replaces the HTTP call with a local, deterministic answer in Apollo's own response shape, so every gate
// after it (spend cap, credit pool, claims, company agreement, role rejection, record-date currency) runs for real. Every person
// is named "Staging ..." on the lead's own domain, so no row can pass for real data. No domain: no match, never an invented one.
// The roster: five non-buyers first, so the buyer is beyond the first five unfiltered employees (criterion 1); a former employee
// and an assistant-to-buyer that share the buyer title words (criterion 2); a buyer record dated 10 days ago (verified current)
// and one dated 200 days ago (search-result-only) (criterion 4). The role filter keeps a person whose title shares a word with a
// requested title (live check: a reviewed buyer role "VP of Sales").
export const stagingFakeApollo = (env: Record<string, string | undefined> = process.env) => isStaging(env) && env.DAZL_STAGING_FAKE_APOLLO === '1'
export const STAGING_APOLLO_ROSTER: readonly { name: string; title: string; daysAgo: number }[] = [
  { name: 'Staging Engineer', title: 'Software Engineer', daysAgo: 5 },
  { name: 'Staging Designer', title: 'Product Designer', daysAgo: 5 },
  { name: 'Staging Supportagent', title: 'Support Agent', daysAgo: 5 },
  { name: 'Staging Analyst', title: 'Data Analyst', daysAgo: 5 },
  { name: 'Staging Coordinator', title: 'Office Coordinator', daysAgo: 5 },
  { name: 'Staging Formerbuyer', title: 'Former VP of Sales', daysAgo: 10 },
  { name: 'Staging Assistant', title: 'Executive Assistant to the VP of Sales', daysAgo: 10 },
  { name: 'Staging Buyer', title: 'VP of Sales', daysAgo: 10 },
  { name: 'Staging Stalebuyer', title: 'VP of Sales, EMEA', daysAgo: 200 },
]
const fakeWords = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !['of', 'the', 'and', 'to', 'at'].includes(w))
function stagingApolloFetch(): typeof fetch {
  return (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> } catch { /* empty body: no match */ }
    const raw = typeof body.q_organization_domains === 'string' ? body.q_organization_domains : typeof body.domain === 'string' ? body.domain : null
    const domain = raw ? raw.toLowerCase() : null
    if (url.includes('/organizations/enrich')) return new Response(JSON.stringify(domain ? { organization: { website_url: `https://${domain}`, primary_domain: domain } } : {}), { status: 200 })
    if (!url.includes('/mixed_people/api_search') || !domain) return new Response(JSON.stringify({ people: [] }), { status: 200 })
    const wanted = new Set((Array.isArray(body.person_titles) ? body.person_titles : []).flatMap(t => typeof t === 'string' ? fakeWords(t) : []))
    const perPage = typeof body.per_page === 'number' ? body.per_page : 5
    const rows = STAGING_APOLLO_ROSTER.filter(p => wanted.size === 0 || fakeWords(p.title).some(w => wanted.has(w))).slice(0, perPage)
    const now = Date.now()
    return new Response(JSON.stringify({ people: rows.map(p => ({ name: p.name, title: p.title, linkedin_url: null, organization: { primary_domain: domain }, last_refreshed_at: new Date(now - p.daysAgo * 86_400_000).toISOString() })) }), { status: 200 })
  }) as typeof fetch
}
const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : null)

// 1 credit per call.
export async function apolloOrgEnrich(apiKey: string, org: { domain?: string | null; name?: string | null }, fetchImpl: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): Promise<ApolloOrg | null> {
  if (stagingFakeApollo(env)) fetchImpl = stagingApolloFetch()
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
export async function apolloPeopleSearch(apiKey: string, org: { domain?: string | null; name: string }, fetchImpl: typeof fetch = fetch, max = 5, role?: { titles: string[] }, env: Record<string, string | undefined> = process.env): Promise<ApolloPerson[]> {
  if (stagingFakeApollo(env)) fetchImpl = stagingApolloFetch()
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

// #1036: ONE user-requested work-email lookup for ONE named person (Find work email on a lead). people/match is a paid
// enrichment on the tenant's own Apollo plan; no scan calls it. Unlike the search above it keeps the work email AND
// Apollo's own email_status, so the caller (lib/people/work-email.ts) shows as checked only an address Apollo itself
// reports as verified. Personal emails and phone numbers are never requested (reveal_* false) and never read. Every
// field is bounded and must be a string; any other shape is null.
export interface ApolloMatch { name: string | null; first: string | null; last: string | null; title: string | null; email: string | null; emailStatus: string | null; country: string | null; orgDomain: string | null; linkedin: string | null }
export async function apolloPersonMatch(apiKey: string, q: { first: string; last: string; domain: string; organization?: string | null }, fetchImpl: typeof fetch = fetch): Promise<ApolloMatch | null> {
  const body: Record<string, unknown> = { first_name: q.first, last_name: q.last, domain: q.domain, reveal_personal_emails: false, reveal_phone_number: false }
  if (q.organization) body.organization_name = q.organization
  const j = await call(apiKey, '/api/v1/people/match', body, fetchImpl) as { person?: unknown } | null
  const p = j && typeof j === 'object' && j.person && typeof j.person === 'object' && !Array.isArray(j.person) ? j.person as Record<string, unknown> : null
  if (!p) return null
  const org = orgOf(p)
  return {
    name: clean(p.name, 120), first: clean(p.first_name, 60), last: clean(p.last_name, 60), title: clean(p.title, 120),
    email: clean(p.email, 254), emailStatus: clean(p.email_status, 40), country: clean(p.country, 80),
    orgDomain: org?.domain ?? null, linkedin: clean(p.linkedin_url),
  }
}
