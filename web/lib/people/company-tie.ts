// #1037 (Hermes-PC review of PR #1164): a public profile search result names an employer, and a company NAME is not a company.
// On staging 5 of 9 stored people were at a different business with the same name ("Garage", "Nautilus", "Syncly"). So a
// search result is kept only when something beyond the name ties it to THIS lead's company:
//   domain   the result's own text names the lead's CONFIRMED website (the caller passes a domain only when
//            lib/signals/domain-basis.ts domainConfirmed holds; a guessed domain may be the other business's);
//   source   the lead was found on its Y Combinator company page, and the result's text gives a company of that name with a YC
//            batch right after it ("Garage (YC W24)"). A mere mention of YC ("investor in YC companies", "YC alum") is not one.
//            Known limit: the lead's own batch is not stored, so the batch is not compared;
//   place    the request names a CITY (requestedCities) and the result's own text names that city as a place, outside the
//            company's own name (and nothing in it disagrees: lib/scan/place-agreement.ts). The weakest tie: a same-name business
//            in the same city would pass. A country, a state, a province or an area is never enough ("United States", "Texas").
// Anything else is a name-only match: not stored. Pure (no data layer).
import { knownCity, regionNamed } from '../scan/place-agreement.ts'

export type CompanyTie = 'domain' | 'source' | 'place'
export interface TieLead { company: string; confirmed_domain?: string | null; source_url?: string | null }
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const urlOf = (u: unknown): URL | null => { try { return typeof u === 'string' ? new URL(u) : null } catch { return null } }
// The cities a request names. Positive evidence only (a list of regions can never be complete: "Japan", "Bavaria", "Midwest"):
//   "City, Region" where the part after the comma is a region the place rule knows ("Toronto, Ontario", "Austin, TX", "Lyon, France"),
//   or a bare name on the place rule's own list of cities ("Toronto", "London").
// A region by itself, an area ("Bay Area", "Silicon Valley") and any name the place rule does not know is not a city here.
export function requestedCities(where: readonly unknown[]): string[] {
  const out: string[] = []
  for (const w of where) {
    if (typeof w !== 'string') continue
    const parts = w.split(',').map(x => x.replace(/\s+/g, ' ').trim())
    const city = parts[0]
    if (city.length < 3 || city.length > 60 || !/^[\p{L}][\p{L} .'’-]*$/u.test(city)) continue
    const withRegion = parts.length >= 2 && parts.slice(1).some(x => regionNamed(x) || /^d\.?\s?c\.?$/i.test(x))
    // "New York, NY" is the city; "New York" alone is the state. A bare region is never a city.
    if (withRegion ? true : knownCity(city) && !regionNamed(city)) out.push(city)
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
      const head = text.slice(0, m.index)
      // Part of a longer name: a letter, digit or joiner attached to it ("Super-Garage", "O'Garage", "Nautilus/Garage", "Nautilus.Garage"),
      // or "&", "/", "+" before it even with a space ("Smith & Garage"). A spaced " - " or " | " is a separator, not a joiner.
      if (/[\p{L}\p{N}\-&'’/.+]$/u.test(head) || /[&/+]\s+$/.test(head)) continue
      const before = /([\p{L}][\p{L}'’&-]*)\s+$/u.exec(head)?.[1] ?? ''
      if (/^the$/i.test(before)) continue   // "The Garage": another name
      if (!before || !/^\p{Lu}/u.test(before) || /^(?:at|of|for|in|ceo|cto|coo|founder|co-?founder|cofounder)$/i.test(before)) return 'source'
    }
  }
  // The city must be named as a PLACE: not inside the company's own name ("Austin Logistics" names no place).
  const placeText = words.join('').length >= 3 ? text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${words.map(esc).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), ' ') : text
  if (placeAgrees && requestedCities(where).some(c => new RegExp(`(?<![\\p{L}\\p{N}])${esc(c)}(?![\\p{L}\\p{N}])`, 'iu').test(placeText))) return 'place'
  return null
}

// The label a stored search result carries. Only a label written by tiedLabel counts as tied: a row stored before this rule
// (the bare label) is a name-only match. lib/people/rank.ts reads it (nameOnly) for every surface that lists or picks a person.
const TIE_TEXT: Record<CompanyTie, string> = { domain: 'the result names its website', source: 'the result gives its Y Combinator batch', place: 'the result names the requested city' }
const MARK = '; company confirmed beyond its name: '
export const tiedLabel = (base: string, tie: CompanyTie): string => `${base}${MARK}${TIE_TEXT[tie]}`
export const companyTied = (label: unknown): boolean => typeof label === 'string' && Object.values(TIE_TEXT).some(t => label.endsWith(`${MARK}${t}`))
export const NAME_ONLY_SOURCE = 'a public LinkedIn search result matched by the company name only - this may be a different business with the same name'
