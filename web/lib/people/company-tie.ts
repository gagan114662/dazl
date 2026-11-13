// #1037 (Hermes-PC review of PR #1164): a public profile search result names an employer, and a company NAME is not a company.
// On staging 5 of 9 stored people were at a different business with the same name ("Garage", "Nautilus", "Syncly"). So a
// search result is kept only when something beyond the name ties it to THIS lead's company:
//   domain   the result's own text names the lead's CONFIRMED website (the caller passes a domain only when
//            lib/signals/domain-basis.ts domainConfirmed holds; a guessed domain may be the other business's);
//   source   the lead was found on its Y Combinator company page, and the result's text gives the company's name with its YC
//            batch right after it ("Garage (YC W24)"). A mere mention of YC ("investor in YC companies", "YC alum") is not one;
//   place    the request names a CITY and the result's own text names that city (and nothing in it disagrees:
//            lib/scan/place-agreement.ts). The weakest tie: a same-name business in the same city would pass. A country, a state
//            or a province is never enough ("United States", "Texas").
// Anything else is a name-only match: not stored. Pure (no data layer).
import { US_STATES } from '../scan/place-agreement.ts'

export type CompanyTie = 'domain' | 'source' | 'place'
export interface TieLead { company: string; confirmed_domain?: string | null; source_url?: string | null }
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const urlOf = (u: unknown): URL | null => { try { return typeof u === 'string' ? new URL(u) : null } catch { return null } }
// Regions that are not a city: countries, UK nations, Canadian provinces, Australian states, continents (US states: US_STATES).
const REGIONS = new Set(['united states', 'united states of america', 'usa', 'us', 'u.s.', 'america', 'north america', 'canada', 'united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland', 'ireland', 'australia', 'new zealand', 'india', 'germany', 'france', 'spain', 'italy', 'netherlands', 'sweden', 'norway', 'denmark', 'finland', 'europe', 'eu', 'emea', 'apac', 'asia', 'africa', 'latin america', 'worldwide', 'global', 'remote',
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick', 'new south wales', 'nsw', 'victoria', 'queensland', 'western australia', 'south australia', 'tasmania',
  ...Object.values(US_STATES), ...Object.keys(US_STATES).map(k => k.toLowerCase())])
// The cities a request names: the first part of each place ("Toronto, Ontario" -> Toronto), unless it is a region.
export function requestedCities(where: readonly unknown[]): string[] {
  const out: string[] = []
  for (const w of where) {
    if (typeof w !== 'string') continue
    const city = w.split(',')[0].replace(/\s+/g, ' ').trim()
    // A city that shares its state's name is a city only when written with the state after it ("New York, NY", "Washington, DC").
    const cityNamedLikeState = /^new york,\s*(?:ny|new york)\b/i.test(w.trim()) || /^washington,\s*d\.?\s?c\.?/i.test(w.trim())
    if (city.length >= 3 && city.length <= 60 && /^[\p{L}][\p{L} .'’-]*$/u.test(city) && (cityNamedLikeState || !REGIONS.has(city.toLowerCase()))) out.push(city)
  }
  return out
}

export function companyTie(resultText: string, lead: TieLead, where: readonly unknown[] = [], placeAgrees = false): CompanyTie | null {
  const text = typeof resultText === 'string' ? resultText.replace(/\bwww\./gi, '') : ''
  const domain = typeof lead.confirmed_domain === 'string' ? lead.confirmed_domain.toLowerCase().replace(/^www\./, '').trim() : ''
  // The domain as a whole token ("withgarage.com", not "notwithgarage.com" or "withgarage.community").
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && new RegExp(`(?<![a-z0-9.-])${esc(domain)}(?![a-z0-9-]|\\.[a-z0-9])`, 'i').test(text)) return 'domain'
  // Found on the company's own Y Combinator page (ycombinator.com/companies/...; not Hacker News, not a YC blog post).
  const src = urlOf(lead.source_url)
  const words = typeof lead.company === 'string' ? lead.company.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean) : []
  if (src && /^(www\.)?ycombinator\.com$/i.test(src.hostname) && src.pathname.startsWith('/companies/') && words.join('').length >= 3) {
    // "<Company> (YC W24)": the batch right after the name, and the name not the tail of a longer one ("The Garage (YC S20)" is not "Garage").
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(esc).join('\\s+')}\\s*[,·|–-]?\\s*\\(?\\s*YC\\s?[WSFX]\\s?\\d{2}(?!\\d)`, 'giu')
    for (const m of text.matchAll(re)) {
      const before = /([\p{L}][\p{L}'’&-]*)\s+$/u.exec(text.slice(0, m.index))?.[1] ?? ''
      if (!before || !/^\p{Lu}/u.test(before) || /^(?:At|Of|For|In|CEO|CTO|COO|Founder|Co-?founder|Cofounder)$/.test(before)) return 'source'
    }
  }
  if (placeAgrees && requestedCities(where).some(c => new RegExp(`(?<![\\p{L}\\p{N}])${esc(c)}(?![\\p{L}\\p{N}])`, 'iu').test(text))) return 'place'
  return null
}

// The label a stored search result carries. Only a label written by tiedLabel counts as tied: a row stored before this rule
// (the bare label) is a name-only match. lib/people/rank.ts reads it (nameOnly) for every surface that lists or picks a person.
const TIE_TEXT: Record<CompanyTie, string> = { domain: 'the result names its website', source: 'the result gives its Y Combinator batch', place: 'the result names the requested city' }
const MARK = '; company confirmed beyond its name: '
export const tiedLabel = (base: string, tie: CompanyTie): string => `${base}${MARK}${TIE_TEXT[tie]}`
export const companyTied = (label: unknown): boolean => typeof label === 'string' && Object.values(TIE_TEXT).some(t => label.endsWith(`${MARK}${t}`))
export const NAME_ONLY_SOURCE = 'a public LinkedIn search result matched by the company name only - this may be a different business with the same name'
