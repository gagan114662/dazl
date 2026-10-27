// Location agreement: a company name alone is not an identity ("Dent Blanche" exists in more than one city). When the request names
// a place, the cited page / profile result is attached to a company only if its own text binds the company to that place. A request with
// no place makes no demand (never invents a geography).
//   agrees      - the text names the requested place and no competing company address
//   mismatch    - the text names a DIFFERENT place (another state, another New York town, another UK city, London Ontario ...) and the requested
//                 place is only incidental (a footer, a "we also serve", an unrelated news mention)
//   unconfirmed - the text names no place at all
// City-scoped requests (New York City, London) are judged at city level: the country or state in the request is context, never enough.
const US_STATES: Record<string, string> = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' }
const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ,.]+/g, ' ').replace(/\s+/g, ' ').trim()
const SUFFIX = /\s+(city|metro|metropolitan area|area|region|county|state|province|district)$/i
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const has = (hay: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(term)}(?![a-z0-9])`).test(hay)

// ---- New York City ----
const NYC_PLACES = ['new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island', 'harlem', 'astoria', 'flushing', 'long island city', 'jamaica', 'williamsburg', 'soho', 'tribeca', 'midtown', 'upper east side', 'upper west side', 'east village', 'west village', 'chelsea', 'forest hills', 'bayside', 'ridgewood', 'sunnyside', 'woodside', 'jackson heights', 'park slope', 'bushwick', 'greenpoint', 'financial district', 'murray hill', 'gramercy', 'kips bay', 'washington heights', 'inwood', 'riverdale', 'rego park', 'elmhurst', 'corona', 'fresh meadows', 'whitestone', 'cobble hill', 'dumbo', 'fort greene', 'bay ridge', 'sunset park', 'crown heights', 'bed stuy', 'bedford stuyvesant', 'red hook', 'carroll gardens', 'boerum hill']
const NYC_TERMS = ['new york city', 'nyc', 'new york ny', 'new york, ny', 'new york, new york', 'new york new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island']
const NYC_ASK = /\b(?:new york city|nyc|manhattan|brooklyn|queens|bronx|staten island|new york,\s*(?:ny|new york))\b/i
const NYC_STREET = /\b\d{1,5}\s+[\p{L}0-9'\- ]{2,40}?\s(?:st|street|ave|avenue|broadway|rd|road|blvd|boulevard|pl|place|plaza|sq|square|dr|drive|way|ln|lane|pkwy|parkway)\b\.?(?:,?\s*(?:fl(?:oor)?|suite|ste|apt|unit)\.?\s*\w+)?,\s*(?:new york|manhattan|brooklyn|queens|the bronx|bronx|staten island|long island city|astoria|flushing)\.?,?\s*(?:ny|new york)\s+(?:10[0-4]\d{2}|11[0-6]\d{2})\b/iu
function otherNyCity(text: string): string | null {
  for (const m of text.matchAll(/\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(?:NY\b|New York\b)/gu)) {
    const city = clean(m[1]).replace(/\.$/, '')
    if (!NYC_PLACES.includes(city) && !NYC_PLACES.some(p => city.endsWith(` ${p}`)) && city !== 'new york city') return m[1]
  }
  return null
}
function otherUsState(text: string, ours: string[]): string | null {
  const t = clean(text)
  for (const [ab, name] of Object.entries(US_STATES)) {
    if (ours.includes(ab)) continue
    if (name !== 'washington' && name !== 'new york' && has(t, name)) return name
    if (new RegExp(`, ${ab.toLowerCase()}(?![a-z])`).test(t)) return name
  }
  return null
}
function nycVerdict(text: string): PlaceVerdict {
  const t = clean(text); const named = NYC_TERMS.some(x => has(t, x))
  const other = otherNyCity(text) ?? otherUsState(text, ['NY'])
  if (NYC_STREET.test(text)) return 'agrees' // a street address in the city (number + street + NYC ZIP); a bare "New York, NY 10001" in a news line does not bind the company
  if (other) return 'mismatch' // another town / state is named and no NYC address binds the company to the city
  return named ? 'agrees' : 'unconfirmed'
}

// ---- London (UK) ----
const LONDON_TERMS = ['london', 'greater london']
const UK_CITIES = ['manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh', 'liverpool', 'bristol', 'sheffield', 'newcastle', 'nottingham', 'cardiff', 'belfast', 'leicester', 'oxford', 'cambridge', 'brighton', 'southampton', 'reading', 'york', 'bath', 'aberdeen', 'dundee', 'swansea', 'coventry', 'norwich', 'exeter', 'milton keynes', 'plymouth', 'derby', 'hull']
const LONDON_ADDRESS = /\blondon\s+(?:(?:EC|WC|SE|SW|NW|N|E|W)\d{1,2}[A-Z]?(?:\s*\d[A-Z]{2})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i
const NOT_UK_LONDON = /\blondon,?\s*(?:ontario|on|canada|kentucky|ky|ohio|oh|ct|connecticut|south africa|eastern cape|za)\b|\blondon\s*\(\s*(?:ontario|canada|kentucky|ohio|south africa)/i
function londonVerdict(text: string): PlaceVerdict {
  const t = clean(text)
  // Another UK city named as a place ("Manchester, England", "Leeds, UK") or a UK city on an address line.
  let other = UK_CITIES.find(c => new RegExp(`(?<![a-z0-9])${esc(c)},?\\s*(?:england|scotland|wales|northern ireland|uk|u\\.k\\.|united kingdom)(?![a-z0-9])`).test(t)) ?? null
  if (!other) for (const m of text.matchAll(/\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(?:England|Scotland|Wales|Northern Ireland|UK|U\.K\.|United Kingdom)\b/gu)) if (clean(m[1]) !== 'london') { other = m[1]; break }
  if (NOT_UK_LONDON.test(text) && !LONDON_ADDRESS.test(text)) return 'mismatch' // London, Ontario / East London, South Africa is not London, UK; an unrelated "London, UK" or UK news line does not bind the company, only a London postcode address does
  if (other && !LONDON_ADDRESS.test(text)) return 'mismatch'
  if (LONDON_TERMS.some(x => has(t, x))) return 'agrees'
  return 'unconfirmed'
}

const GENERIC_ALIAS: Record<string, string[]> = {}
export function geoTerms(where: string[]): string[] {
  const out = new Set<string>()
  const cityScoped = where.some(w => NYC_ASK.test(w) || /\blondon\b/i.test(w))
  for (const w of where) {
    if (NYC_ASK.test(w)) { for (const t of NYC_TERMS) out.add(t); continue }
    if (/\blondon\b/i.test(w)) { for (const t of LONDON_TERMS) out.add(t); continue }
    if (cityScoped) continue // a country / state beside a city entry (London + UK, New York City + New York) is context, never a match on its own
    const c = clean(w).replace(SUFFIX, ''); if (c.length < 3) continue
    out.add(c); for (const part of c.split(',')) { const p = part.trim().replace(SUFFIX, ''); if (p.length >= 3) out.add(p) }
    for (const t of GENERIC_ALIAS[c] ?? []) out.add(t)
  }
  return [...out]
}
export const namesPlace = (text: string, terms: string[]) => { const t = clean(text); return terms.some(x => has(t, x)) }
export type PlaceVerdict = 'agrees' | 'unconfirmed' | 'mismatch' | 'no_geography'
export function placeAgreement(text: string, where: string[]): PlaceVerdict {
  const terms = geoTerms(where); if (terms.length === 0) return 'no_geography'
  const verdicts: PlaceVerdict[] = []
  if (where.some(w => NYC_ASK.test(w))) verdicts.push(nycVerdict(text))
  if (where.some(w => /\blondon\b/i.test(w))) verdicts.push(londonVerdict(text))
  if (verdicts.length) return verdicts.includes('agrees') ? 'agrees' : verdicts.includes('mismatch') ? 'mismatch' : 'unconfirmed'
  if (namesPlace(text, terms)) return 'agrees'
  const ours = Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase() || x.endsWith(`, ${ab.toLowerCase()}`))).map(([ab]) => ab)
  return otherUsState(text, ours) ? 'mismatch' : 'unconfirmed'
}
// kept for callers that only need the "another US state" signal
export const otherState = (text: string, terms: string[]) => otherUsState(text, Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase())).map(([ab]) => ab))
export { otherState as otherUsStateName }
