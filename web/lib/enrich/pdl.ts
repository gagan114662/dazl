// People Data Labs via the tenant's OWN key (BYOK). Same rules as Apollo: no key, no calls.
// Free tier: 100 records/month, person search costs 1 credit per profile returned.
// Docs: https://docs.peopledatalabs.com/docs/create-an-account
import { EnrichError, type ApolloPerson } from './apollo.ts'

const BASE = 'https://api.peopledatalabs.com'
const TIMEOUT_MS = 15_000

// 1 credit per profile returned. Names/titles only - emails/phones are never read.
import { formatPlace } from '../scan/contact-agreement.ts'
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
export async function pdlPeopleSearch(apiKey: string, orgName: string, fetchImpl: typeof fetch = fetch, max = 5): Promise<ApolloPerson[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetchImpl(`${BASE}/v5/person/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ size: max, query: { bool: { must: [{ term: { job_company_name: orgName.toLowerCase() } }] } } }),
      signal: ctrl.signal,
    })
    if (r.status === 429) throw new EnrichError('rate_limited', 'PDL rate limit reached')
    if (r.status === 401 || r.status === 403) throw new EnrichError('auth', 'PDL rejected the key')
    if (!r.ok) throw new EnrichError('upstream', `PDL returned ${r.status}`)
    const j = await r.json() as { data?: Record<string, unknown>[] }
    return (j.data ?? []).slice(0, max).map(p => ({
      name: (typeof p.full_name === 'string' ? p.full_name : '').slice(0, 120),
      title: typeof p.job_title === 'string' ? p.job_title.slice(0, 120) : null,
      linkedin: typeof p.linkedin_url === 'string' ? p.linkedin_url.slice(0, 200) : null,
      // Where the person works and the company's site, so a same-name company elsewhere can be told apart (lib/scan/contact-agreement.ts).
      // EMPLOYER location only. A person's own residence (location_*) says nothing about where the company is: never a fallback.
      place: formatPlace(str(p.job_company_location_locality), str(p.job_company_location_region), str(p.job_company_location_country)),
      domain: str(p.job_company_website),
    })).filter(p => p.name)
  } finally { clearTimeout(t) }
}
