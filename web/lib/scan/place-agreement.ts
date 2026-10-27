// Location agreement: a company name alone is not an identity ("Dent Blanche" exists in more than one city). When the request names
// a place, evidence pages and profile results are attached to a company only if their own text names that place; text that names a
// DIFFERENT US state or country instead is a mismatch. A request with no place makes no demand (never invents a geography).
const US_STATES: Record<string, string> = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' }
const ALIASES: { ask: RegExp; terms: string[] }[] = [
  { ask: /\b(?:new york city|nyc|manhattan|brooklyn|queens|bronx|staten island)\b/i, terms: ['new york city', 'nyc', 'new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island'] },
  { ask: /\b(?:london|united kingdom|great britain|england|uk)\b/i, terms: ['london', 'united kingdom', 'england', 'great britain', 'greater london'] },
]
const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ,.]+/g, ' ').replace(/\s+/g, ' ').trim()
const SUFFIX = /\s+(city|metro|metropolitan area|area|region|county|state|province|district)$/i

// Terms that count as "this place" for a request's geography. Empty = no geography = no demand.
export function geoTerms(where: string[]): string[] {
  const out = new Set<string>()
  for (const w of where) {
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
export function placeAgreement(text: string, where: string[]): PlaceVerdict {
  const terms = geoTerms(where); if (terms.length === 0) return 'no_geography'
  if (namesPlace(text, terms)) return 'agrees'
  return otherUsState(text, terms) ? 'mismatch' : 'unconfirmed'
}
