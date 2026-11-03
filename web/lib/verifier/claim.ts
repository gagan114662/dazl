// What the independent evidence verifier is asked to check (docs/design/evidence-verifier.md). blindClaim copies an
// allowlisted set of claim fields and nothing else, so the verdict cannot depend on who or what produced the lead: the
// producer's model, provider, prompt, rationale, confidence, own "verified" flag, score and any page text or excerpt it
// carries are dropped before any check runs (their field NAMES are kept for the audit trail, never their values). The
// verifier always fetches the cited pages itself.
import { createHash } from 'node:crypto'

export interface LeadClaim {
  company: string
  domain: string                                   // the company's own registrable domain
  place: { city: string; country: string | null } | null
  event: { date: string; source_url: string; corroborating_urls: string[] }
  quotes: { text: string; source_url: string }[]
  person: { name: string; title: string; source_url: string } | null
  contact: { email: string; source_url: string } | null
  predicates: { text: string; source_url: string }[]  // requested ICP predicates, judged semantically (judge.ts)
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

  const list = <T>(v: unknown, path: string, max: number, keys: string[], build: (o: Record<string, unknown>) => T | null): T[] => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || v.length > max) { problems.push(`${path} is malformed`); return [] }
    return v.flatMap((x, i) => {
      const o = obj(x)
      if (!o) { problems.push(`${path}[${i}] is malformed`); return [] }
      const r = take(o, `${path}[${i}]`, keys, build)
      return r === null ? [] : [r]
    })
  }
  const quotes = list(input.quotes, 'quotes', LIMITS.quotes, ['text', 'source_url'], o => { const text = str(o.text), source_url = httpUrl(o.source_url); return text && source_url ? { text, source_url } : null })
  if (quotes.length === 0) problems.push('no quote is cited')
  const predicates = list(input.predicates, 'predicates', LIMITS.predicates, ['text', 'source_url'], o => { const text = str(o.text, 300), source_url = httpUrl(o.source_url); return text && source_url ? { text, source_url } : null })
  const person = input.person == null ? null : take(obj(input.person), 'person', ['name', 'title', 'source_url'], o => { const name = str(o.name, 150), title = str(o.title, 150), source_url = httpUrl(o.source_url); return name && title && source_url ? { name, title, source_url } : null })
  const contact = input.contact == null ? null : take(obj(input.contact), 'contact', ['email', 'source_url'], o => {
    const email = str(o.email, 254)?.toLowerCase(), source_url = httpUrl(o.source_url)
    return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && source_url ? { email, source_url } : null
  })
  if (input.person != null && !obj(input.person)) problems.push('person is malformed')
  if (input.contact != null && !obj(input.contact)) problems.push('contact is malformed')

  const claim: LeadClaim = {
    company: company ?? '', domain: domain ?? '', place,
    event: event ?? { date: '', source_url: '', corroborating_urls: [] },
    quotes, person, contact, predicates,
  }
  const claimHash = createHash('sha256').update(JSON.stringify(claim)).digest('hex')
  return { claim, claimHash, dropped: [...dropped].sort(), producerModel: producerModelOf(input), problems: [...new Set(problems)] }
}
