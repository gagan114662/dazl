// What the independent evidence verifier is asked to check (#780/#781, part of #395). blindClaim copies an
// allowlisted set of claim fields and nothing else, so the verdict cannot depend on who or what produced the lead:
// the producer's model, provider, prompt, rationale, confidence, own "verified" flag, score and any page text or
// excerpt it carries are dropped before any check runs (their field NAMES are kept for the audit trail, never their
// values). The verifier always fetches the cited pages itself (service.ts, a separate PR) rather than trusting the
// producer's copy.
//
// Scope: company identity, domain binding, place, event date and quote corroboration (#780); person/contact-route
// (#781); requested ICP predicates (judged by service.ts's separately configured judge, never by the producer), the
// canonical claim hash and the producer's model name (read only to refuse a judge that is the producer, #395).
import { createHash } from 'node:crypto'
import { PUBLISHED_EMAIL_RE } from '../outreach/published-email.ts'

export interface LeadClaim {
  company: string
  domain: string                                   // the company's own registrable domain
  place: { city: string; country: string | null } | null
  event: { date: string; source_url: string; corroborating_urls: string[] }
  quotes: { text: string; source_url: string }[]
  person: { name: string; title: string; source_url: string } | null
  contact: { email: string; source_url: string } | null
  // Requested ICP predicates, judged semantically (service.ts). Always set by blindClaim; optional only so a hand-built
  // claim with no predicates (the deterministic-check fixtures) need not spell out an empty list.
  predicates?: { text: string; source_url: string }[]
}

export interface Blinded {
  claim: LeadClaim
  claimHash: string        // sha256 of the canonical blinded claim: the same claim from any producer hashes the same
  dropped: string[]        // names (only) of input fields the verifier did not take
  producerModel: string | null // read only to refuse a judge that is the producer's own model; never stored or shown
  problems: string[]       // why the claim cannot be fully evaluated (missing or malformed parts)
}

export const LIMITS = { text: 500, urls: 5, quotes: 5, predicates: 5 }
const CLAIM_KEYS = new Set(['company', 'domain', 'place', 'event', 'quotes', 'person', 'contact', 'predicates'])

const str = (v: unknown, max = LIMITS.text): string | null => typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
export const httpUrl = (v: unknown): string | null => {
  const s = str(v)
  if (!s) return null
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString() : null } catch { return null }
}

function producerModelOf(input: Record<string, unknown>): string | null {
  for (const k of ['producer_model', 'model']) { const s = str(input[k], 200); if (s) return s }
  const p = obj(input.producer)
  return p ? str(p.model, 200) : null
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

  // Quotes are optional - a claim that cites none is not thereby malformed, it simply has no quote_on_source checks.
  const quotesIn = input.quotes
  let quotes: { text: string; source_url: string }[] = []
  if (quotesIn !== undefined && quotesIn !== null) {
    if (!Array.isArray(quotesIn) || quotesIn.length > LIMITS.quotes) problems.push('quotes is malformed')
    else quotes = quotesIn.flatMap((x, i) => {
      const o = obj(x)
      if (!o) { problems.push(`quotes[${i}] is malformed`); return [] }
      const q = take(o, `quotes[${i}]`, ['text', 'source_url'], oo => { const text = str(oo.text), source_url = httpUrl(oo.source_url); return text && source_url ? { text, source_url } : null })
      return q ? [q] : []
    })
  }

  // Predicates are optional too: none requested means no predicate_judged checks.
  const predicatesIn = input.predicates
  let predicates: { text: string; source_url: string }[] = []
  if (predicatesIn !== undefined && predicatesIn !== null) {
    if (!Array.isArray(predicatesIn) || predicatesIn.length > LIMITS.predicates) problems.push('predicates is malformed')
    else predicates = predicatesIn.flatMap((x, i) => {
      const o = obj(x)
      if (!o) { problems.push(`predicates[${i}] is malformed`); return [] }
      const q = take(o, `predicates[${i}]`, ['text', 'source_url'], oo => { const text = str(oo.text, 300), source_url = httpUrl(oo.source_url); return text && source_url ? { text, source_url } : null })
      return q ? [q] : []
    })
  }

  const person = input.person == null ? null : take(obj(input.person), 'person', ['name', 'title', 'source_url'], o => { const name = str(o.name, 150), title = str(o.title, 150), source_url = httpUrl(o.source_url); return name && title && source_url ? { name, title, source_url } : null })
  if (input.person != null && !obj(input.person)) problems.push('person is malformed')
  const contact = input.contact == null ? null : take(obj(input.contact), 'contact', ['email', 'source_url'], o => {
    const email = str(o.email, 254)?.toLowerCase(), source_url = httpUrl(o.source_url)
    return email && PUBLISHED_EMAIL_RE.test(email) && source_url ? { email, source_url } : null
  })
  if (input.contact != null && !obj(input.contact)) problems.push('contact is malformed')

  const claim: LeadClaim = {
    company: company ?? '', domain: domain ?? '', place,
    event: event ?? { date: '', source_url: '', corroborating_urls: [] },
    quotes, person, contact, predicates,
  }
  const claimHash = createHash('sha256').update(JSON.stringify(claim)).digest('hex')
  return { claim, claimHash, dropped: [...dropped].sort(), producerModel: producerModelOf(input), problems: [...new Set(problems)] }
}
