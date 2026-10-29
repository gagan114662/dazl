// Location agreement: a company name alone is not an identity ("Dent Blanche" exists in more than one city). When the request names
// a place, the cited page / profile result is attached to a company only if its own text binds the company to that place. A request with
// no place makes no demand (never invents a geography).
//   agrees      - the text names the requested place and no competing company address
//   mismatch    - the text names a DIFFERENT place (another state, another New York town, another UK city, London Ontario ...) and the requested
//                 place is only incidental (a footer, a "we also serve", an unrelated news mention)
//   unconfirmed - the text names no place at all (a page naming only a different place, in any country, is a mismatch: otherPlace below)
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
  return named ? 'agrees' : otherPlace(text, ['New York City']) ? 'mismatch' : 'unconfirmed'
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
  return otherPlace(text, ['London, United Kingdom']) ? 'mismatch' : 'unconfirmed' // Paris, Berlin, Toronto ... and no London at all
}

// India, the UAE and the neighbouring Gulf states: a page that names a DIFFERENT city of the list than the one asked for is a place conflict, not "unconfirmed" (Mumbai for Gurugram, Abu Dhabi or Doha for
// Dubai). Doha, Riyadh ... are listed as other countries' cities. A city and its alternate names are one metro; "Delhi NCR" counts for Delhi, Gurugram and Noida. Only used when the request itself
// is a listed city or names India / the UAE, so no other request is affected.
const METROS: string[][] = [
  ['delhi', 'new delhi'], ['gurugram', 'gurgaon'], ['noida'], ['faridabad'], ['mumbai', 'bombay'], ['bengaluru', 'bangalore'], ['hyderabad'], ['chennai', 'madras'], ['kolkata', 'calcutta'], ['pune'], ['ahmedabad'], ['jaipur'],
  ['dubai'], ['abu dhabi'], ['sharjah'], ['ajman'], ['ras al khaimah'], ['fujairah'],
  ['doha'], ['riyadh'], ['jeddah'], ['kuwait city'], ['manama'], ['muscat'],
]
const NCR_METROS = new Set(['delhi', 'gurugram', 'noida', 'faridabad'])
const named = (t: string, name: string) => new RegExp(`(^| )${name}( |$)`).test(t)
// An alternate name of the asked city (Gurgaon for Gurugram, Bangalore for Bengaluru, Bombay for Mumbai) is the same place.
export function askedMetroAlias(text: string, terms: string[]): boolean {
  const t = clean(text).replace(/[,.]+/g, ' ').replace(/ +/g, ' ')
  return METROS.some(m => m.some(n => terms.some(x => x === n || x.startsWith(`${n},`))) && m.some(n => named(t, n)))
}
export function otherListedCity(text: string, terms: string[]): string | null {
  const t = clean(text).replace(/[,.]+/g, ' ').replace(/ +/g, ' '), ours = new Set(METROS.filter(m => m.some(n => terms.some(x => x === n || x.startsWith(`${n},`) || x === `${n} india`))).map(m => m[0]))
  const COUNTRY = /^(india|uae|united arab emirates|emirates)$/
  const countryAsked = terms.some(x => COUNTRY.test(x)), cityAsked = terms.some(x => !x.includes(',') && !COUNTRY.test(x))   // a COUNTRY-level request (India) accepts every city of it
  if (ours.size === 0 && !(countryAsked && cityAsked)) return null
  const ncr = /\b(?:delhi ncr|ncr|national capital region)\b/.test(t) && [...ours].some(m => NCR_METROS.has(m))
  for (const m of METROS) {
    if (ours.has(m[0])) continue
    if (ncr && NCR_METROS.has(m[0])) continue
    if (m.some(n => named(t, n))) return m[0]
  }
  return null
}

// An explicit, company-bound HEADQUARTERS in a different listed city ("Orbitly is based in Mumbai") outranks every broad signal that would otherwise agree: a country token shared with the request
// ("India"), or an incidental mention of the asked city or its alias ("a conference in Gurgaon"). Only a sentence that binds the asked city to the company itself ("Orbitly is based in
// Gurgaon", "Our office is in Gurgaon") restores agreement; the bind rule is the same short own-address allow-list used for NYC and London. Requests with no listed city are not affected.
const metroRe = (m: string[]) => new RegExp(`(?<![a-z0-9])(?:${m.map(n => esc(n).replace(/ /g, '\\s+')).join('|')})(?![a-z0-9])`, 'i')
function boundOtherListedCity(text: string, terms: string[], company?: string): string | null {
  const ours = METROS.filter(m => m.some(n => terms.some(x => x === n || x.startsWith(`${n},`) || x === `${n} india`)))
  if (ours.length === 0) return null
  if (ours.some(m => ownAddress(text, metroRe(m), company))) return null
  const other = METROS.find(m => !ours.includes(m) && ownAddress(text, metroRe(m), company))
  return other ? other[0] : null
}

// When the request names a listed city, the country beside it ("India", "UAE", "Qatar") is context, never enough: "Orbitly is headquartered in Mumbai, India" shares the token "india" with a
// Gurugram request but sits in another city. Only the city (or an alias, or "city, country") can agree; a country-only request keeps every term, so it still accepts any city of the country.
function cityLevelTerms(terms: string[]): string[] {
  const isMetro = (x: string) => METROS.some(m => m.some(n => x === n || x.startsWith(`${n},`)))
  return terms.some(isMetro) ? terms.filter(isMetro) : terms
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
// ---- Any other city, any country ----
// The lists above only know NYC towns, UK cities and the India / Gulf metros, so a page that plainly names Paris, Berlin or
// Toronto used to be "unconfirmed" for a London request, and the scan kept it (#440: a Paris startup verified for London).
// This detector answers one question: does the text name a place that is clearly NOT the requested one? It is consulted only
// where a verdict would otherwise be "unconfirmed", plus one early check for the requested city's name in another country
// ("Paris, Texas" for "Paris, France"), which a bare "paris" term used to call agreement.
// "Clearly a place" is either "City, Region" (a country, US state, Canadian province or Australian state after a comma) or a
// bare name from a short list of major cities whose names are not also ordinary words or common first names. Each city is
// compared at the granularity the request asked for: a city request rejects any other city; a country or state request
// rejects only places outside it ("Berlin" agrees with a Germany request, "Rome, NY" with a New York state request).
// The India / Gulf metros are left to the METROS rules above (they carry the "Delhi NCR counts for Gurugram" exception).
interface Region { country: string; state?: string }
const COUNTRY_ALIASES: Record<string, string[]> = {
  'united kingdom': ['United Kingdom', 'UK', 'U.K.', 'England', 'Scotland', 'Wales', 'Northern Ireland', 'Great Britain', 'Britain'],
  'united states': ['United States', 'USA', 'U.S.A.', 'US', 'U.S.'], canada: ['Canada'], australia: ['Australia'], 'new zealand': ['New Zealand'],
  ireland: ['Ireland'], france: ['France'], germany: ['Germany', 'Deutschland'], spain: ['Spain', 'España'], portugal: ['Portugal'], italy: ['Italy', 'Italia'],
  netherlands: ['Netherlands', 'The Netherlands', 'Holland'], belgium: ['Belgium'], switzerland: ['Switzerland'], austria: ['Austria'], sweden: ['Sweden'],
  denmark: ['Denmark'], norway: ['Norway'], finland: ['Finland'], poland: ['Poland'], 'czech republic': ['Czech Republic', 'Czechia'], hungary: ['Hungary'],
  greece: ['Greece'], turkey: ['Turkey', 'Türkiye'], russia: ['Russia'], israel: ['Israel'], egypt: ['Egypt'], nigeria: ['Nigeria'], kenya: ['Kenya'],
  'south africa': ['South Africa'], india: ['India'], 'united arab emirates': ['United Arab Emirates', 'UAE'], qatar: ['Qatar'], 'saudi arabia': ['Saudi Arabia'],
  singapore: ['Singapore'], china: ['China'], 'hong kong': ['Hong Kong'], japan: ['Japan'], 'south korea': ['South Korea', 'Korea'], mexico: ['Mexico', 'México'],
  brazil: ['Brazil', 'Brasil'], argentina: ['Argentina'], colombia: ['Colombia'], peru: ['Peru'], chile: ['Chile'],
}
const CA_PROVINCES: Record<string, string[]> = { ontario: ['Ontario', 'ON'], quebec: ['Quebec', 'Québec', 'QC'], 'british columbia': ['British Columbia', 'BC'], alberta: ['Alberta', 'AB'], manitoba: ['Manitoba', 'MB'], 'nova scotia': ['Nova Scotia', 'NS'] }
const AU_STATES: Record<string, string[]> = { 'new south wales': ['New South Wales', 'NSW'], victoria: ['Victoria', 'VIC'], queensland: ['Queensland', 'QLD'], 'western australia': ['Western Australia', 'WA'] }
const titled = (n: string) => n.replace(/\b[a-z]/g, c => c.toUpperCase())
// Region alias (as written in text, case-sensitive so "in", "on", "us" in prose never read as a region) -> region.
const REGION_ALIASES = new Map<string, Region>()
for (const [country, as] of Object.entries(COUNTRY_ALIASES)) for (const a of as) REGION_ALIASES.set(a, { country })
for (const [ab, name] of Object.entries(US_STATES)) { REGION_ALIASES.set(ab, { country: 'united states', state: name }); REGION_ALIASES.set(titled(name), { country: 'united states', state: name }) }
for (const [name, as] of Object.entries(CA_PROVINCES)) for (const a of as) REGION_ALIASES.set(a, { country: 'canada', state: name })
for (const [name, as] of Object.entries(AU_STATES)) for (const a of as) if (a !== 'WA') REGION_ALIASES.set(a, { country: 'australia', state: name }) // WA is Washington
const REGION_ALT = [...REGION_ALIASES.keys()].sort((a, b) => b.length - a.length).map(a => esc(a).replace(/ /g, '\\s+')).join('|')
const CITY_COMMA_REGION = new RegExp(`\\b([A-Z][\\p{L}'.-]+(?: [A-Z][\\p{L}'.-]+){0,2}),\\s*(${REGION_ALT})(?![\\p{L}])`, 'gu')
const NOT_A_CITY = /^(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|pl|place|plaza|sq|square|ln|lane|way|pkwy|broadway|inc|ltd|llc|plc|gmbh|suite|floor)$/
// Major cities by name -> region. Excluded on purpose: names that are ordinary words or first names (Nice, Reading, Bath,
// York, Mobile, Phoenix, Victoria, Split, Austin, Sydney, Jackson, Lincoln, Washington, Houston), and the METROS cities.
const WORLD_CITIES: Record<string, Region> = Object.fromEntries(([
  ['paris', 'france'], ['lyon', 'france'], ['marseille', 'france'], ['berlin', 'germany'], ['munich', 'germany'], ['hamburg', 'germany'], ['frankfurt', 'germany'], ['cologne', 'germany'],
  ['madrid', 'spain'], ['barcelona', 'spain'], ['lisbon', 'portugal'], ['rome', 'italy'], ['milan', 'italy'], ['amsterdam', 'netherlands'], ['rotterdam', 'netherlands'],
  ['brussels', 'belgium'], ['vienna', 'austria'], ['zurich', 'switzerland'], ['geneva', 'switzerland'], ['stockholm', 'sweden'], ['copenhagen', 'denmark'], ['oslo', 'norway'],
  ['helsinki', 'finland'], ['dublin', 'ireland'], ['warsaw', 'poland'], ['prague', 'czech republic'], ['budapest', 'hungary'], ['athens', 'greece'], ['istanbul', 'turkey'],
  ['moscow', 'russia'], ['tel aviv', 'israel'], ['cairo', 'egypt'], ['lagos', 'nigeria'], ['nairobi', 'kenya'], ['johannesburg', 'south africa'], ['cape town', 'south africa'],
  ['singapore', 'singapore'], ['hong kong', 'hong kong'], ['shanghai', 'china'], ['beijing', 'china'], ['shenzhen', 'china'], ['tokyo', 'japan'], ['osaka', 'japan'], ['seoul', 'south korea'],
  ['melbourne', 'australia'], ['brisbane', 'australia'], ['auckland', 'new zealand'], ['toronto', 'canada'], ['vancouver', 'canada'], ['montreal', 'canada'],
  ['san francisco', 'united states'], ['los angeles', 'united states'], ['chicago', 'united states'], ['boston', 'united states'], ['seattle', 'united states'], ['miami', 'united states'],
  ['denver', 'united states'], ['atlanta', 'united states'], ['dallas', 'united states'], ['philadelphia', 'united states'], ['mexico city', 'mexico'], ['sao paulo', 'brazil'],
  ['rio de janeiro', 'brazil'], ['buenos aires', 'argentina'], ['bogota', 'colombia'], ['santiago', 'chile'],
  ['london', 'united kingdom'], ['manchester', 'united kingdom'], ['birmingham', 'united kingdom'], ['leeds', 'united kingdom'], ['glasgow', 'united kingdom'], ['edinburgh', 'united kingdom'],
  ['liverpool', 'united kingdom'], ['bristol', 'united kingdom'], ['cardiff', 'united kingdom'], ['belfast', 'united kingdom'],
] as const).map(([c, country]) => [c, { country }]))
const US_CITY_STATE: Record<string, string> = { 'san francisco': 'california', 'los angeles': 'california', chicago: 'illinois', boston: 'massachusetts', seattle: 'washington', miami: 'florida', denver: 'colorado', atlanta: 'georgia', dallas: 'texas', philadelphia: 'pennsylvania' }
for (const [c, st] of Object.entries(US_CITY_STATE)) WORLD_CITIES[c] = { country: 'united states', state: st }
const BARE_CITY = new RegExp(`(?<![\\p{L}])(${Object.keys(WORLD_CITIES).map(c => titled(c).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}])`, 'gu')
const plain = (s: string) => clean(s).replace(/[,.]+/g, ' ').replace(/ +/g, ' ').trim()

interface Ask { cities: Map<string, Region | null>; regions: Region[] } // a city's region is null when the request does not say and the city is not listed
function regionOf(name: string): Region | null {
  for (const [a, r] of REGION_ALIASES) if (plain(a) === plain(name)) return r
  return null
}
function askOf(where: string[]): Ask {
  const ask: Ask = { cities: new Map(), regions: [] }
  for (const w of where) {
    const parts = w.split(',').map(x => x.trim()).filter(Boolean)
    if (parts.length === 0) continue
    const tail = parts.length > 1 ? regionOf(parts[parts.length - 1]) : null
    const head = regionOf(parts[0])
    if (head && parts.length === 1) { ask.regions.push(head); continue }        // "Germany", "Texas"
    const city = plain(parts[0]).replace(SUFFIX, '')
    if (NYC_ASK.test(w)) { for (const c of NYC_PLACES) ask.cities.set(c, { country: 'united states', state: 'new york' }); continue }
    ask.cities.set(city, tail ?? WORLD_CITIES[city] ?? null)
  }
  return ask
}
const inRegion = (r: Region, scope: Region) => r.country === scope.country && (!scope.state || r.state === scope.state)
// A place the text names that is clearly not the requested one. `same_name`: the requested city's name in another region.
export function otherPlace(text: string, where: string[]): { kind: 'other' | 'same_name'; place: string } | null {
  const ask = askOf(where)
  if (ask.cities.size === 0 && ask.regions.length === 0) return null
  let rest = text
  let found: { kind: 'other' | 'same_name'; place: string } | null = null
  const differs = (city: string, r: Region | null, label: string): { kind: 'other' | 'same_name'; place: string } | null => {
    if (ask.cities.size) {
      if (!ask.cities.has(city)) return ask.regions.length && r && ask.regions.some(x => inRegion(r, x)) ? null : { kind: 'other', place: label }
      const want = ask.cities.get(city)
      return want && r && !inRegion(r, { country: want.country, ...(want.state && r.state ? { state: want.state } : {}) }) ? { kind: 'same_name', place: label } : null
    }
    return r && !ask.regions.some(x => inRegion(r, x)) ? { kind: 'other', place: label } : null
  }
  const sameNameHere = new Set<string>() // the requested city named WITH its requested region: a same-name mention elsewhere is then incidental
  for (const m of text.matchAll(CITY_COMMA_REGION)) {
    const city = plain(m[1]); const r = REGION_ALIASES.get(m[2].replace(/\s+/g, ' '))!
    if (NOT_A_CITY.test(city.split(' ').pop() ?? '') || regionOf(m[1])) continue           // "57th St, New York", "England, UK"
    rest = rest.replace(m[0], ' ')
    const d = differs(city, r, m[0])
    if (!d && ask.cities.has(city)) sameNameHere.add(city)
    if (d && (!found || (found.kind === 'same_name' && d.kind === 'other'))) found = d
  }
  if (found?.kind === 'same_name' && [...sameNameHere].length) found = null
  if (found) return found
  // The US has a namesake of most world cities (Rome NY, Paris TX, Athens GA), so for a US request a bare foreign name is
  // not clearly elsewhere; only its "City, Region" form above counts.
  const usAsk = [...ask.cities.values(), ...ask.regions].some(r => r?.country === 'united states')
  for (const m of rest.matchAll(BARE_CITY)) {
    const city = plain(m[1])
    if (ask.cities.has(city) || (usAsk && WORLD_CITIES[city].country !== 'united states')) continue
    const d = differs(city, WORLD_CITIES[city], m[1])
    if (d) return d
  }
  return null
}

export type PlaceVerdict = 'agrees' | 'unconfirmed' | 'mismatch' | 'no_geography'
// `company` (optional) is the candidate company's name: an address binds the company when its own sentence names it. Without it only first-person addresses bind.
export function placeAgreement(text: string, where: string[], company?: string): PlaceVerdict {
  const terms = geoTerms(where); if (terms.length === 0) return 'no_geography'
  const verdicts: PlaceVerdict[] = []
  if (where.some(w => NYC_ASK.test(w))) verdicts.push(nycVerdict(text, company))
  if (where.some(w => /\blondon\b/i.test(w))) verdicts.push(londonVerdict(text, company))
  if (verdicts.length) return verdicts.includes('agrees') ? 'agrees' : verdicts.includes('mismatch') ? 'mismatch' : 'unconfirmed'
  if (boundOtherListedCity(text, terms, company)) return 'mismatch'
  if (otherPlace(text, where)?.kind === 'same_name') return 'mismatch' // "Paris, Texas" for "Paris, France": the bare name would agree below
  if (namesPlace(text, cityLevelTerms(terms))) return 'agrees'
  if (askedMetroAlias(text, terms)) return 'agrees'
  if (otherListedCity(text, terms)) return 'mismatch'
  const ours = Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase() || x.endsWith(`, ${ab.toLowerCase()}`))).map(([ab]) => ab)
  return otherUsState(text, ours) || otherPlace(text, where) ? 'mismatch' : 'unconfirmed'
}
// kept for callers that only need the "another US state" signal
export const otherState = (text: string, terms: string[]) => otherUsState(text, Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase())).map(([ab]) => ab))
export { otherState as otherUsStateName }

// True when the request names New York City or London: the country / state beside it is context, never enough to attach a company.
export const cityScoped = (where: string[]): boolean => where.some(w => NYC_ASK.test(w) || /\blondon\b/i.test(w))
