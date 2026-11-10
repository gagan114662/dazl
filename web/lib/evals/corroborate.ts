// Deterministic corroboration of company, domain, place and event date from independently retrieved pages (#780, part of #395).
// Pure: it is handed pages somebody else fetched and returns the contract's LeadEvidence (lib/evals/contract.ts, #394). It does not fetch, call a model or
// read the clock. The lead's own claim says what to look for; only the pages say what is true.
//
// Rules, each with a seeded case in test/evidence-corroboration.test.ts:
//  - IDENTITY. A page counts for the company only if it carries the company's name AND is not published for another entity. A same-name company at another
//    domain is reported as that other domain, so the contract finds the identity contradicted, never confirmed.
//  - PLACE. The page's places are every known place its text names, so a wrong-city page reads as that other city (fail), not as silence (unknown).
//  - EVENT DATE. The date must be STATED in the page text, in an accepted form. A publication date is metadata about the page, not about the event: an old article
//    with a fresh published_at supports nothing. A future date is reported as given, so the contract fails it.
//  - SOURCES. A page supports the event only if it names the company and states the claimed date. Independence is decided by the contract (registrable domains).
import { isDay, registrable, type LeadEvidence } from './contract.ts'

export interface SourcePage { url: string; text: string; published_at?: string | null; entity_domains?: string[] }
export interface Claim { company: string; domain: string | null; source_url: string | null; quote: string | null; event_kind: string; event_date: string | null; contact_email?: string | null; consent?: 'allowed' | 'blocked' | null }
export interface CollectOptions { places: string[]; industries: string[]; known_places: string[] }  // wanted (from the frozen contract) and a gazetteer for "another city"

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const names = (hay: string, needle: string) => needle.trim() !== '' && ` ${norm(hay)} `.includes(` ${norm(needle)} `)
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const pad = (n: number) => String(n).padStart(2, '0')

// Every calendar day the text STATES, as YYYY-MM-DD. Forms: 2026-10-08, October 8, 2026 / Oct 8, 2026, 8 October 2026. A form counts only as a whole token.
export function statedDays(text: string): string[] {
  const out = new Set<string>(), t = text.toLowerCase()
  for (const m of t.matchAll(/(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`)
  const mon = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
  const idx = (s: string) => MONTHS.findIndex(x => x.startsWith(s.slice(0, 3)))
  for (const m of t.matchAll(new RegExp(`(?<![\\w])${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\d])`, 'g'))) out.add(`${m[3]}-${pad(idx(m[1]) + 1)}-${pad(Number(m[2]))}`)
  for (const m of t.matchAll(new RegExp(`(?<![\\w\\d])(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon},?\\s+(\\d{4})(?![\\d])`, 'g'))) out.add(`${m[3]}-${pad(idx(m[2]) + 1)}-${pad(Number(m[1]))}`)
  return [...out].filter(isDay)
}

export function collectEvidence(claim: Claim, pages: SourcePage[], o: CollectOptions): LeadEvidence {
  const claimed = claim.domain ? registrable(claim.domain.toLowerCase().replace(/^www\./, '')) : null
  const about = pages.filter(p => names(p.text, claim.company))
  // identity: a page about this company at its own domain (or with no domain stated) confirms; one published for another entity's domain does not.
  const observed_names: string[] = [], observed_domains: string[] = []
  for (const p of about) {
    const doms = (p.entity_domains ?? []).map(d => registrable(d.toLowerCase().replace(/^www\./, '')))
    if (!doms.length || (claimed && doms.includes(claimed))) { observed_names.push(claim.company); if (claimed && doms.includes(claimed)) observed_domains.push(claimed) }
    else observed_domains.push(...doms)
  }
  // Conflicting evidence wins: if any page names the company at another entity's domain, no page may confirm the name.
  const elsewhere = observed_domains.some(d => d !== claimed)
  if (elsewhere) observed_names.length = 0
  const cited = pages.find(p => p.url === claim.source_url)
  const lower = (cited?.text ?? '')
  const seen = (list: string[]) => [...new Set(list.filter(x => names(lower, x)))]
  const supporting = claim.event_date ? about.filter(p => statedDays(p.text).includes(claim.event_date!)) : []
  return {
    company: claim.company, claimed_domain: claim.domain, source_url: claim.source_url, quote: claim.quote,
    page_text: cited?.text ?? null,
    observed_names: [...new Set(observed_names)], observed_domains: [...new Set(observed_domains)],
    places: cited ? seen([...o.known_places, ...o.places]) : [],
    industries: cited ? seen(o.industries) : [],
    event: claim.event_date ? { kind: claim.event_kind, date: supporting.length ? claim.event_date : null, sources: supporting.map(p => ({ url: p.url })) } : null,
    consent: claim.consent ?? null,
    contact: claim.contact_email ? { email: claim.contact_email } : null,
  }
}
