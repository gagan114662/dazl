// People Data Labs via the tenant's OWN key (BYOK). Same rules as Apollo: no key, no calls.
// Free tier: 100 records/month, person search costs 1 credit per profile returned.
// Docs: https://docs.peopledatalabs.com/docs/create-an-account
import { EnrichError, type ApolloPerson } from './apollo.ts'

const BASE = 'https://api.peopledatalabs.com'
import { reserveScanSpend, unitCostUsd } from '../scan/spend-cap.ts'
const TIMEOUT_MS = 15_000

// 1 credit per profile returned. Names/titles only - emails/phones are never read.
import { formatPlace } from '../scan/contact-agreement.ts'
import { isMailboxShaped } from './person-name.ts'
import { latestDay } from '../people/currency.ts'
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
export async function pdlPeopleSearch(apiKey: string, orgName: string, fetchImpl: typeof fetch = fetch, max = 5): Promise<ApolloPerson[]> {
  // Inside a scan: PDL bills per profile returned, so the worst case is the size asked for, reserved on the scan's
  // spend cap first (lib/scan/spend-cap.ts); a refusal (SpendRefused) sends nothing.
  const hold = await reserveScanSpend('pdl.people', () => unitCostUsd('pdl.people', max))
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    let r: Response
    try {
      r = await fetchImpl(`${BASE}/v5/person/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ size: max, query: { bool: { must: [{ term: { job_company_name: orgName.toLowerCase() } }] } } }),
        signal: ctrl.signal,
      })
    } catch (e) { hold?.uncertain(); throw e } // timeout / dropped connection after send: may have been billed, the row stays 'reserved' and the attempt stops paying (#363)
    // PDL bills per profile RETURNED: the reservation (the size asked for) moves to what came back. A 404 is PDL's "no
    // match", which it does not bill; any other failure, or a body that cannot be read, keeps the full reservation.
    if (!r.ok) { if (r.status === 404 || [400, 401, 403, 413, 429].includes(r.status)) await hold?.settle(r.status === 404 ? 0 : null); else hold?.uncertain() } // 404 no match is not billed (existing rule); other documented rejections are counted (kept), never claimed uncharged; any other failure: maybe billed
    if (r.status === 429) throw new EnrichError('rate_limited', 'PDL rate limit reached')
    if (r.status === 401 || r.status === 403) throw new EnrichError('auth', 'PDL rejected the key')
    if (!r.ok) throw new EnrichError('upstream', `PDL returned ${r.status}`)
    let j: { data?: Record<string, unknown>[] }
    try { j = await r.json() as { data?: Record<string, unknown>[] } } catch (e) { hold?.uncertain(); throw e } // answered but unreadable: billed for an unknown amount, the row stays 'reserved' (#363)
    if (hold) { if (Array.isArray(j?.data)) await hold.settle((hold.usd / max) * j.data.length); else hold.uncertain() }
    // Filter mailbox/team labels BEFORE the clamp, same as Apollo, so they cannot consume the row budget. The settle
    // above stays on the raw profiles PDL RETURNED (that is what it bills), never on the filtered count.
    return (j.data ?? []).map(p => ({
      name: (typeof p.full_name === 'string' ? p.full_name : '').slice(0, 120),
      title: typeof p.job_title === 'string' ? p.job_title.slice(0, 120) : null,
      linkedin: typeof p.linkedin_url === 'string' ? p.linkedin_url.slice(0, 200) : null,
      // Where the person works and the company's site, so a same-name company elsewhere can be told apart (lib/scan/contact-agreement.ts).
      // EMPLOYER location only. A person's own residence (location_*) says nothing about where the company is: never a fallback.
      place: formatPlace(str(p.job_company_location_locality), str(p.job_company_location_region), str(p.job_company_location_country)),
      address: str(p.job_company_location_street_address),
      domain: str(p.job_company_website),
      // The record's own job last-verified / last-changed date (#383 criterion 4); any other shape is null.
      recordDay: latestDay(p.job_last_verified, p.job_last_changed),
    })).filter(p => p.name && !isMailboxShaped(p.name)).slice(0, max)
  } finally { clearTimeout(t) }
}
