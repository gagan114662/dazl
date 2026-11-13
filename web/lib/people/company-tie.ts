// #1037 (Hermes-PC review of PR #1164): a public profile search result names an employer, and a company NAME is not a company.
// On staging 5 of 9 stored people were at a different business with the same name ("Garage", "Nautilus", "Syncly"). So a
// search result is kept only when something beyond the name ties it to THIS lead's company:
//   domain   the result's own text names the lead's CONFIRMED website (the caller passes a domain only when
//            lib/signals/domain-basis.ts domainConfirmed holds; a guessed domain may be the other business's);
//   source   the lead was found on its Y Combinator company page, and the result's text gives a company of that name with a YC
//            batch right after it ("Garage (YC W24)"). A mere mention of YC ("investor in YC companies", "YC alum") is not one.
//            Known limit: the lead's own batch is not stored, so the batch is not compared;
//   place    the request names a CITY the place rule knows (requestedCities) and the result's own text names that city itself
//            (not "Greater X Area") as a place, outside the company's own name (and nothing in it disagrees: lib/scan/place-agreement.ts). The weakest tie: a same-name business
//            in the same city would pass. A country, a state, a province or an area is never enough ("United States", "Texas").
// Anything else is a name-only match: not stored. Pure (no data layer).
import { knownCity, regionNamed } from '../scan/place-agreement.ts'

export type CompanyTie = 'domain' | 'source' | 'place'
export interface TieLead { company: string; confirmed_domain?: string | null; source_url?: string | null }
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const urlOf = (u: unknown): URL | null => { try { return typeof u === 'string' ? new URL(u) : null } catch { return null } }
// The cities a request names: only a name on the place rule's own list of cities (lib/scan/place-agreement.ts knownCity:
// "Toronto", "London", "Chicago"), written bare or as "City, Region". Positive evidence only - no list of what is NOT a city can
// be complete ("Japan", "Bavaria", "Texas, United States", "Bay Area, CA", "Remote, US" all name no city). A city that list does
// not carry ("Austin", "Sydney") therefore never ties: fail closed.
export function requestedCities(where: readonly unknown[]): string[] {
  const out: string[] = []
  for (const w of where) {
    if (typeof w !== 'string') continue
    const parts = w.split(',').map(x => x.replace(/\s+/g, ' ').trim())
    const city = parts[0]
    // "New York, NY" and "Washington, DC" are the cities; "New York" and "Washington" alone are the states.
    const namedLikeState = (/^new york$/i.test(city) && /^(?:ny|new york)$/i.test(parts[1] ?? '')) || (/^washington$/i.test(city) && /^d\.?\s?c\.?$/i.test(parts[1] ?? ''))
    if (namedLikeState || (knownCity(city) && !regionNamed(city))) out.push(city)
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
      // The word right before the name must be nothing (the start, or after a spaced separator) or a plain connector / role word.
      // Any other word, in any letter case, makes it a longer name ("The Garage", "Mega Garage", "nautilus garage").
      const before = (/([\p{L}][\p{L}'’&.-]*)\s+$/u.exec(head)?.[1] ?? '').replace(/\.$/, '')
      if (!before || /^(?:at|of|for|in|with|by|from|and|ceo|cto|coo|founder|co-?founder|cofounder|owner)$/i.test(before)) return 'source'
    }
  }
  // The city must be named as a PLACE: not inside the company's own name ("Austin Logistics" names no place).
  const placeText = words.join('').length >= 3 ? text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${words.map(esc).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), ' ') : text
  // ... and as the city itself, not a wider area around it ("Greater Toronto Area", "Toronto Metropolitan Area").
  if (placeAgrees && requestedCities(where).some(c => new RegExp(`(?<![\\p{L}\\p{N}])(?<!greater\\s)${esc(c)}(?![\\p{L}\\p{N}])(?!\\s+(?:area|metro|metropolitan|region|bay)\\b)`, 'iu').test(placeText))) return 'place'
  return null
}

// The label a stored search result carries. Only a label written by tiedLabel counts as tied: a row stored before this rule
// (the bare label) is a name-only match. lib/people/rank.ts reads it (nameOnly) for every surface that lists or picks a person.
const TIE_TEXT: Record<CompanyTie, string> = { domain: 'the result names its website', source: 'the result gives its Y Combinator batch', place: 'the result names the requested city' }
const MARK = '; company confirmed beyond its name: '
export const tiedLabel = (base: string, tie: CompanyTie): string => `${base}${MARK}${TIE_TEXT[tie]}`
export const companyTied = (label: unknown): boolean => typeof label === 'string' && Object.values(TIE_TEXT).some(t => label.endsWith(`${MARK}${t}`))
export const NAME_ONLY_SOURCE = 'a public LinkedIn search result matched by the company name only - this may be a different business with the same name'
