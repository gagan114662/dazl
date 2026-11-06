// What the independent evidence verifier is asked to check (#780, part of #395). blindClaim copies an allowlisted set
// of claim fields and nothing else, so the verdict cannot depend on who or what produced the lead: the producer's
// model, provider, prompt, rationale, confidence, own "verified" flag, score and any page text or excerpt it carries
// are dropped before any check runs (their field NAMES are kept for the audit trail, never their values). The verifier
// always fetches the cited pages itself (service.ts, a separate PR) rather than trusting the producer's copy.
//
// Scope (#780 only): company identity, domain binding, place and event date. Person/contact-route fields are #781's;
// quotes, predicates and cross-producer blinding/provenance plumbing are later #395 splits (#781/#782) - out of scope
// here so this PR's diff matches its own title.

export interface LeadClaim {
  company: string
  domain: string                                   // the company's own registrable domain
  place: { city: string; country: string | null } | null
  event: { date: string; source_url: string; corroborating_urls: string[] }
}

export interface Blinded {
  claim: LeadClaim
  dropped: string[]        // names (only) of input fields the verifier did not take
  problems: string[]       // why the claim cannot be fully evaluated (missing or malformed parts)
}

export const LIMITS = { text: 500, urls: 5 }
const CLAIM_KEYS = new Set(['company', 'domain', 'place', 'event'])

const str = (v: unknown, max = LIMITS.text): string | null => typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
export const httpUrl = (v: unknown): string | null => {
  const s = str(v)
  if (!s) return null
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString() : null } catch { return null }
}

export function blindClaim(raw: unknown): Blinded {
  const input = obj(raw) ?? {}
  const problems: string[] = []
  const dropped = new Set<string>(Object.keys(input).filter(k => !CLAIM_KEYS.has(k)))
  const take = <T>(o: Record<string, unknown> | null, path: string, keys: string[], build: (o: Record<string, unknown>) => T | null): T | null => {
    if (!o) return null
    for (const k of Object.keys(o)) if (!keys.includes(k)) dropped.add(`${path}.${k}`)
    const r = build(o)
    if (r === null) problems.push(`${path} is malformed`)
    return r
  }
  const company = str(input.company, 150)
  if (!company) problems.push('company is missing')
  const domainRaw = str(input.domain, 253)?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '') ?? null
  const domain = domainRaw && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domainRaw) ? domainRaw : null
  if (!domain) problems.push('domain is missing or malformed')

  const place = take(obj(input.place), 'place', ['city', 'country'], o => { const city = str(o.city, 100); return city ? { city, country: str(o.country, 100) } : null })
  if (!input.place) problems.push('place is missing')

  const eventIn = obj(input.event)
  if (!eventIn) problems.push('event is missing')
  const event = take(eventIn, 'event', ['date', 'source_url', 'corroborating_urls'], o => {
    const date = str(o.date, 10), source_url = httpUrl(o.source_url)
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !source_url) return null
    const extra = Array.isArray(o.corroborating_urls) ? o.corroborating_urls : []
    const corroborating_urls = extra.map(httpUrl).filter((u): u is string => u !== null)
    if (corroborating_urls.length !== extra.length || corroborating_urls.length > LIMITS.urls) return null
    return { date, source_url, corroborating_urls }
  })

  const claim: LeadClaim = {
    company: company ?? '', domain: domain ?? '', place,
    event: event ?? { date: '', source_url: '', corroborating_urls: [] },
  }
  return { claim, dropped: [...dropped].sort(), problems: [...new Set(problems)] }
}
