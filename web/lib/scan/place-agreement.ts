// Location agreement: a company name alone is not an identity ("Dent Blanche" exists in more than one city). When the request names
// a place, evidence pages and profile results are attached to a company only if their own text names that place; text that names a
// DIFFERENT US state or country instead is a mismatch. A request with no place makes no demand (never invents a geography).
const US_STATES: Record<string, string> = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' }
// New York CITY is not New York STATE: a bare "New York" or ", NY" is also Rome, Albany or Buffalo. NYC agrees only on a city-level
// term (the five boroughs, NYC, "New York City", "New York, NY" / "New York, New York" as the city line), and a text that names another
// New York place instead ("Rome, NY") is a mismatch.
const NYC_PLACES = ['new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island', 'harlem', 'astoria', 'flushing', 'long island city', 'jamaica', 'williamsburg', 'soho', 'tribeca', 'midtown', 'upper east side', 'upper west side', 'east village', 'west village', 'chelsea', 'forest hills', 'bayside', 'ridgewood', 'sunnyside', 'woodside', 'jackson heights', 'park slope', 'bushwick', 'greenpoint', 'financial district', 'murray hill', 'gramercy', 'kips bay', 'hell s kitchen', 'washington heights', 'inwood', 'riverdale', 'rego park', 'elmhurst', 'corona', 'fresh meadows', 'whitestone', 'cobble hill', 'dumbo', 'fort greene', 'bay ridge', 'sunset park', 'crown heights', 'bed stuy', 'bedford stuyvesant', 'red hook', 'carroll gardens', 'boerum hill']
const NYC_TERMS = ['new york city', 'nyc', 'new york ny', 'new york, ny', 'new york, new york', 'new york new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island']
const ALIASES: { ask: RegExp; terms: string[]; city?: 'nyc' }[] = [
  { ask: /\b(?:new york city|nyc|manhattan|brooklyn|queens|bronx|staten island|new york,\s*(?:ny|new york))\b/i, terms: NYC_TERMS, city: 'nyc' },
  { ask: /\b(?:london|united kingdom|great britain|england|uk)\b/i, terms: ['london', 'united kingdom', 'england', 'great britain', 'greater london'] },
]
const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ,.]+/g, ' ').replace(/\s+/g, ' ').trim()
const SUFFIX = /\s+(city|metro|metropolitan area|area|region|county|state|province|district)$/i

// Terms that count as "this place" for a request's geography. Empty = no geography = no demand.
export function geoTerms(where: string[]): string[] {
  const out = new Set<string>()
  for (const w of where) {
    // A city-scoped entry (NYC) contributes ONLY its city-level terms: its comma parts ("new york", "ny") are the whole state.
    const cityAlias = ALIASES.find(x => x.city && x.ask.test(w))
    if (cityAlias) { for (const t of cityAlias.terms) out.add(t); continue }
    const c = clean(w).replace(SUFFIX, ''); if (c.length < 3) continue
    out.add(c); for (const part of c.split(',')) { const p = part.trim().replace(SUFFIX, ''); if (p.length >= 3) out.add(p) }
    for (const a of ALIASES) if (a.ask.test(w)) for (const t of a.terms) out.add(t)
  }
  return [...out]
}
const has = (hay: string, term: string) => new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(hay)
export const namesPlace = (text: string, terms: string[]) => { const t = clean(text); return terms.some(x => has(t, x)) }
// Another US state named in the text ("Pico Rivera, CA", "California") that the request's geography does not include.
export function otherUsState(text: string, terms: string[]): string | null {
  const t = clean(text)
  const ours = new Set(Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase() || x.endsWith(`, ${ab.toLowerCase()}`))).map(([ab]) => ab))
  for (const [ab, name] of Object.entries(US_STATES)) {
    if (ours.has(ab)) continue
    if (has(t, name) && name !== 'washington' && name !== 'new york') return name
    if (new RegExp(`, ${ab.toLowerCase()}(?![a-z])`).test(t)) return name
  }
  return null
}
export type PlaceVerdict = 'agrees' | 'unconfirmed' | 'mismatch' | 'no_geography'
// "<City>, NY" / "<City>, New York" where the city is not a New York City place: a different New York town.
function otherNyCity(text: string): string | null {
  for (const m of text.matchAll(/\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(?:NY\b|New York\b)/gu)) {
    const city = clean(m[1]).replace(/\.$/, '')
    if (!NYC_PLACES.includes(city) && !NYC_PLACES.some(p => city.endsWith(` ${p}`)) && city !== 'new york city') return m[1]
  }
  return null
}
// "London, Ontario / ON / KY / OH ..." is not London, UK (unless the UK is named too).
const NOT_UK_LONDON = /\blondon,\s*(?:ontario|on|canada|kentucky|ky|ohio|oh)\b/i
export function placeAgreement(text: string, where: string[]): PlaceVerdict {
  const terms = geoTerms(where); if (terms.length === 0) return 'no_geography'
  const nycScoped = where.some(w => ALIASES.some(a => a.city === 'nyc' && a.ask.test(w)))
  const ukScoped = where.some(w => /\b(?:london|united kingdom|great britain|england|uk)\b/i.test(w))
  if (ukScoped && NOT_UK_LONDON.test(text) && !/\b(?:united kingdom|england|great britain|uk)\b/i.test(text)) return 'mismatch'
  if (namesPlace(text, terms)) return 'agrees'
  if (nycScoped && otherNyCity(text)) return 'mismatch'
  return otherUsState(text, terms) ? 'mismatch' : 'unconfirmed'
}
