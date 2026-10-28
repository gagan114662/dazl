// Location agreement: a company name alone is not an identity ("Dent Blanche" exists in more than one city). When the request names
// a place, the cited page / profile result is attached to a company only if its own text binds the company to that place. A request with
// no place makes no demand (never invents a geography).
//   agrees      - the text names the requested place and no competing company address
//   mismatch    - the text names a DIFFERENT place (another state, another New York town, another UK city, London Ontario ...) and the requested
//                 place is only incidental (a footer, a "we also serve", an unrelated news mention)
//   unconfirmed - the text names no place at all
// City-scoped requests (New York City, London) are judged at city level: the country or state in the request is context, never enough.
export const US_STATES: Record<string, string> = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia' }
const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ,.]+/g, ' ').replace(/\s+/g, ' ').trim()
const SUFFIX = /\s+(city|metro|metropolitan area|area|region|county|state|province|district)$/i
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const has = (hay: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(term)}(?![a-z0-9])`).test(hay)

// ---- New York City ----
const NYC_PLACES = ['new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'the bronx', 'staten island', 'harlem', 'astoria', 'flushing', 'long island city', 'jamaica', 'williamsburg', 'soho', 'tribeca', 'midtown', 'upper east side', 'upper west side', 'east village', 'west village', 'chelsea', 'forest hills', 'bayside', 'ridgewood', 'sunnyside', 'woodside', 'jackson heights', 'park slope', 'bushwick', 'greenpoint', 'financial district', 'murray hill', 'gramercy', 'kips bay', 'washington heights', 'inwood', 'riverdale', 'rego park', 'elmhurst', 'corona', 'fresh meadows', 'whitestone', 'cobble hill', 'dumbo', 'fort greene', 'bay ridge', 'sunset park', 'crown heights', 'bed stuy', 'bedford stuyvesant', 'red hook', 'carroll gardens', 'boerum hill']
const NYC_TERMS = ['new york city', 'nyc', 'new york ny', 'new york, ny', 'new york, new york', 'new york new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island']
const NYC_ASK = /\b(?:new york city|nyc|manhattan|brooklyn|queens|bronx|staten island|new york,\s*(?:ny|new york))\b/i
const NYC_CITY_ALT = [...new Set([...NYC_PLACES, 'new york city', 'manhattan', 'the bronx'])].map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')
const NYC_STREET = new RegExp(`\\b\\d{1,5}(?:-\\d{1,4})?\\s+[\\p{L}0-9'\\- ]{2,40}?\\s(?:st|street|ave|avenue|broadway|rd|road|blvd|boulevard|pl|place|plaza|sq|square|dr|drive|way|ln|lane|pkwy|parkway)\\b\\.?(?:,?\\s*(?:fl(?:oor)?|suite|ste|apt|unit)\\.?\\s*\\w+)?,\\s*(?:${NYC_CITY_ALT})\\.?,?\\s*(?:ny|new york)\\s+(?:10[0-4]\\d{2}|11[0-6]\\d{2})\\b`, 'iu')
// An address binds the COMPANY only when the words in front of it, in its own sentence, tie it to the company: the company's own name
// ("Smile Studio, 57 W 57th St, ...") or first person ("Our UK office: ...", "Visit us at ..."), followed by nothing but connective words.
// "Supplier address: London EC1V 9HX" or "Their lawyer works at 57 W 57th St" are real addresses of other parties and stay unbound; the rule
// is a short allow-list of own-address phrasing, not a list of third parties. A mixed page whose address is unbound stays out of agreement.
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z])|\n+/)
const normName = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/\b(inc|ltd|llc|limited|gmbh|corp|corporation|co|company|plc|pty|group|the)\b/g, ' ').replace(/[^a-z0-9]+/g, '')
const CONNECT = new Set(['is', 'are', 'located', 'based', 'situated', 'found', 'at', 'on', 'in', 'office', 'offices', 'headquarters', 'hq', 'head', 'registered', 'address', 'visit', 'find', 'contact', 'come', 'see', 'us', 'we', 'were', 'our', 'main', 'second', 'new', 'flagship', 'principal', 'primary', 'home', 'uk', 'london', 'nyc', 'york', 'local', 'clinic', 'studio', 'practice', 'branch', 'dental', 'and', 'the'])
const FIRST_PERSON = new Set(['our', 'we', 'us', 'were'])
function bindsToCompany(prefix: string, company?: string): boolean {
  let rest = prefix.trim()
  const n = company ? normName(company) : ''
  let named = false
  if (n.length >= 3) {
    // remove the company's own name (any spacing/punctuation/suffix variant) from the prefix
    const words = company!.replace(/[^\p{L}\p{N}\s&'-]/gu, ' ').split(/\s+/).filter(Boolean)
    for (let i = 0; i < words.length && !named; i++) for (let j = words.length; j > i; j--) {
      const cand = words.slice(i, j).join(' ')
      if (normName(cand).length >= 3 && normName(cand) === n) { const re = new RegExp(esc(cand).replace(/\\? /g, '[\\s,.]+'), 'i'); if (re.test(rest)) { rest = rest.replace(re, ' '); named = true; break } }
    }
  }
  const toks = rest.toLowerCase().replace(/[’']/g, '').split(/[^a-z]+/).filter(Boolean)
  if (!toks.every(w => CONNECT.has(w))) return false
  return named || toks.some(w => FIRST_PERSON.has(w))
}
const ownAddress = (text: string, re: RegExp, company?: string) => sentences(text).some(sn => { const m = re.exec(sn); return !!m && bindsToCompany(sn.slice(0, m.index), company) })
function otherNyCity(text: string): string | null {
  for (const m of text.matchAll(/\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(?:NY\b|New York\b)/gu)) {
    const city = clean(m[1]).replace(/\.$/, '')
    if (/^(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|pl|place|plaza|sq|square|ln|lane|way|pkwy|broadway)$/.test(city.split(' ').pop() ?? '')) continue // "57 W 57th St, New York": a street, not another town
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
function nycVerdict(text: string, company?: string): PlaceVerdict {
  const t = clean(text); const named = NYC_TERMS.some(x => has(t, x))
  const other = otherNyCity(text) ?? otherUsState(text, ['NY'])
  if (ownAddress(text, NYC_STREET, company)) return 'agrees' // a street address in the city (number + street + NYC ZIP); a bare "New York, NY 10001" in a news line does not bind the company
  if (other) return 'mismatch' // another town / state is named and no NYC address binds the company to the city
  return named ? 'agrees' : 'unconfirmed'
}

// ---- London (UK) ----
const LONDON_TERMS = ['london', 'greater london']
const UK_CITIES = ['manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh', 'liverpool', 'bristol', 'sheffield', 'newcastle', 'nottingham', 'cardiff', 'belfast', 'leicester', 'oxford', 'cambridge', 'brighton', 'southampton', 'reading', 'york', 'bath', 'aberdeen', 'dundee', 'swansea', 'coventry', 'norwich', 'exeter', 'milton keynes', 'plymouth', 'derby', 'hull']
const LONDON_ADDRESS = /\blondon\s+(?:(?:EC|WC|SE|SW|NW|N|E|W)\d{1,2}[A-Z]?(?:\s*\d[A-Z]{2})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i
// With its street part when there is one, so the words in front of the street number (not the street name) are what is judged.
const LONDON_STREET = new RegExp(`(?:\\b\\d{1,4}[A-Za-z]?\\s+[\\p{L}'\\- ]{2,40}?,\\s*)?${LONDON_ADDRESS.source}`, 'iu')
const NOT_UK_LONDON = /\blondon,?\s*(?:ontario|on|canada|kentucky|ky|ohio|oh|ct|connecticut|south africa|eastern cape|za)\b|\blondon\s*\(\s*(?:ontario|canada|kentucky|ohio|south africa)/i
function londonVerdict(text: string, company?: string): PlaceVerdict {
  const t = clean(text)
  // Another UK city named as a place ("Manchester, England", "Leeds, UK") or a UK city on an address line.
  let other = UK_CITIES.find(c => new RegExp(`(?<![a-z0-9])${esc(c)},?\\s*(?:england|scotland|wales|northern ireland|uk|u\\.k\\.|united kingdom)(?![a-z0-9])`).test(t)) ?? null
  if (!other) for (const m of text.matchAll(/\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(?:England|Scotland|Wales|Northern Ireland|UK|U\.K\.|United Kingdom)\b/gu)) if (clean(m[1]) !== 'london') { other = m[1]; break }
  if (NOT_UK_LONDON.test(text) && !ownAddress(text, LONDON_STREET, company)) return 'mismatch' // London, Ontario / East London, South Africa is not London, UK; an unrelated "London, UK" or UK news line does not bind the company, only a London postcode address does
  if (other && !ownAddress(text, LONDON_STREET, company)) return 'mismatch'
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
// A funding / event quote that is JOINED to another candidate's hiring evidence must itself sit in the requested place. The page-level verdict above leaves a bare other-city mention
// ("a Manchester startup") unconfirmed, which is fine for a page; for the quote that carries the event it is a conflict. Only capitalized city names, and not the words that are also common
// English (Reading, Bath, York), so a quote is never held for an ordinary word.
const NEVER_BARE = new Set(['reading', 'bath', 'york'])   // ordinary English words / part of New York: never a bare city mention
const CAPITAL_ONLY = new Set(['hull', 'derby'])            // ordinary words too: only the capitalized form names the city
const BARE_UK = UK_CITIES.filter(c => !NEVER_BARE.has(c)).map(c => ({ name: c, ambiguous: CAPITAL_ONLY.has(c) }))
// Case and spacing are normalized on the TEXT side: "manchester", "MANCHESTER" and "Greater  Manchester" are the same city as "Manchester".
export const namesOtherUkCity = (text: string): string | null => {
  const t = text.replace(/\s+/g, ' ')
  for (const c of BARE_UK) {
    const words = c.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
    if (c.ambiguous ? new RegExp(`\\b${words}\\b`).test(t) : new RegExp(`\\b${c.name}\\b`, 'i').test(t)) return c.name
  }
  return null
}
export function eventPlaceOk(text: string, where: string[], company?: string): boolean {
  if (where.length === 0) return true
  if (placeAgreement(text, where, company) === 'mismatch') return false
  if (where.some(w => /\blondon\b/i.test(w)) && !/\blondon\b/i.test(text) && namesOtherUkCity(text)) return false
  return true
}
export type PlaceVerdict = 'agrees' | 'unconfirmed' | 'mismatch' | 'no_geography'
// `company` (optional) is the candidate company's name: an address binds the company when its own sentence names it. Without it only first-person addresses bind.
export function placeAgreement(text: string, where: string[], company?: string): PlaceVerdict {
  const terms = geoTerms(where); if (terms.length === 0) return 'no_geography'
  const verdicts: PlaceVerdict[] = []
  if (where.some(w => NYC_ASK.test(w))) verdicts.push(nycVerdict(text, company))
  if (where.some(w => /\blondon\b/i.test(w))) verdicts.push(londonVerdict(text, company))
  if (verdicts.length) return verdicts.includes('agrees') ? 'agrees' : verdicts.includes('mismatch') ? 'mismatch' : 'unconfirmed'
  if (namesPlace(text, terms)) return 'agrees'
  const ours = Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase() || x.endsWith(`, ${ab.toLowerCase()}`))).map(([ab]) => ab)
  return otherUsState(text, ours) ? 'mismatch' : 'unconfirmed'
}
// kept for callers that only need the "another US state" signal
export const otherState = (text: string, terms: string[]) => otherUsState(text, Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase())).map(([ab]) => ab))
export { otherState as otherUsStateName }

// True when the request names New York City or London: the country / state beside it is context, never enough to attach a company.
export const cityScoped = (where: string[]): boolean => where.some(w => NYC_ASK.test(w) || /\blondon\b/i.test(w))
