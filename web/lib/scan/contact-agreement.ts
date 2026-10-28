// Before a contact or company record from an enrichment source (Apollo, People Data Labs, a crawled site) is attached to a lead, it must AGREE
// with the lead: on the company's domain, or on the city/state the scan is about (city-level for New York City and London, see place-agreement.ts).
// A same-name practice in Pico Rivera, CA must never be attached to a New York lead. A refusal carries a plain reason for the audit trail.
import type Database from 'better-sqlite3'
import { placeAgreement, cityScoped, US_STATES } from './place-agreement.ts'
import { addEnrichment } from '../connectors/store.ts'
import { WHY_MAX } from './score.ts'

export interface Candidate { domain?: string | null; place?: string | null; address?: string | null; keyedOnLeadDomain?: boolean } // keyedOnLeadDomain: the lookup was made BY the lead's own domain       // place: "City, ST" (or free text) as the source reports it
export interface LeadSide { company_domain?: string | null; where: string[]; evidence?: string | null } // evidence: the lead's OWN evidence text (its quote, its cited page): a street address in it is a basis
export type Agreement = { ok: true; via: 'domain' | 'location' | 'address' | 'no_geography' } | { ok: false; reason: string }

const registrable = (d: string | null | undefined): string | null => {
  if (!d) return null
  const host = d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null
}
const STATE_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([ab, name]) => [name, ab]))
// "Pico Rivera", "California" -> "Pico Rivera, CA"; anything else is kept as the source wrote it.
export function formatPlace(city?: string | null, state?: string | null, country?: string | null): string | null {
  const title = (x: string) => (x === x.toLowerCase() ? x.replace(/\b([a-z])/g, m => m.toUpperCase()) : x)   // PDL returns lower-case places
  const c = title((city ?? '').trim()), st0 = (state ?? '').trim(), co = title((country ?? '').trim())
  const st = st0 ? (STATE_ABBR[st0.toLowerCase()] ?? st0) : ''
  const us = !co || /^(us|usa|united states)/i.test(co)
  const out = [c, st, !c && !st ? co : (us || !co ? '' : co)].filter(Boolean).join(', ')
  return out || null
}
// How the lead's side is named in a reason.
export function leadPlaceLabel(where: string[]): string {
  const w = where.find(x => x.trim()) ?? 'the requested place'
  if (/\b(?:new york city|nyc|manhattan|brooklyn|queens|bronx|staten island)\b|new york,\s*(?:ny|new york)/i.test(w)) return 'New York, NY'
  if (/\blondon\b/i.test(w)) return 'London, UK'
  return w.trim()
}

// ---- street addresses: "57 W 57th St" == "57 West 57th Street" ----
const DIR: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' }
const SUFFIX: Record<string, string> = { street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', boulevard: 'blvd', blvd: 'blvd', road: 'rd', rd: 'rd', drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', place: 'pl', pl: 'pl', parkway: 'pkwy', pkwy: 'pkwy', court: 'ct', ct: 'ct', square: 'sq', sq: 'sq', way: 'way', broadway: 'broadway', highway: 'hwy', hwy: 'hwy' }
const STREET = /\b(\d{1,5}(?:-\d{1,4})?)\s+((?:[NSEW]\.?|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\s+)?([A-Za-z0-9'\u2019. -]{1,40}?)\s*\b(Street|St|Avenue|Ave|Av|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Place|Pl|Parkway|Pkwy|Court|Ct|Square|Sq|Way|Broadway|Highway|Hwy)\b\.?/gi
export function streetKeys(text: string | null | undefined): string[] {
  const out = new Set<string>()
  for (const m of (text ?? '').matchAll(STREET)) {
    const dir = (m[2] ?? '').replace(/[.\s]/g, '').toLowerCase()
    const name = m[3].toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    if (!name || name.split(' ').length > 4) continue
    out.add(`${m[1]} ${DIR[dir] ?? dir} ${name} ${SUFFIX[m[4].toLowerCase()] ?? m[4].toLowerCase()}`.replace(/\s+/g, ' '))
  }
  return [...out]
}
// agrees: the same street address; conflict: both sides name a street address and none is the same; unknown: one side names none.
export function addressAgreement(candidateAddress: string | null | undefined, leadEvidence: string | null | undefined): 'agrees' | 'conflict' | 'unknown' {
  const a = streetKeys(candidateAddress), b = streetKeys(leadEvidence)
  if (a.length === 0 || b.length === 0) return 'unknown'
  return a.some(x => b.includes(x)) ? 'agrees' : 'conflict'
}

// The place the lead's OWN evidence states: "City, ST" / "City, State", else New York City / London named outright. Used when the search location is empty.
export function evidencedPlace(text: string | null | undefined): string | null {
  const t = text ?? ''
  return firstPlaceLabel(t) ?? (/\b(?:New York(?: City)?|NYC|Manhattan|Brooklyn)\b/.test(t) ? 'New York City' : /\bLondon\b/.test(t) ? 'London' : null)
}
// The request's places; when the search location is empty, the lead's own evidenced city/state stands in (the check is never skipped just because the ask named no place).
function effectiveWhere(lead: LeadSide): string[] {
  const w = lead.where.filter(x => x.trim())
  if (w.length) return w
  const ev = evidencedPlace(lead.evidence)
  return ev ? [ev] : []
}
// Everything an address writes AFTER its street: "57 W 57th St, Toronto, ON M5V 2T6, Canada" -> "Toronto, ON M5V 2T6, Canada". Empty when it states no geography.
export function addressGeography(address: string | null | undefined): string {
  return (address ?? '').replace(STREET, ' ').split(',').map(x => x.trim()).filter(Boolean).join(', ')
}
// "57 W 57th St, New York" in the lead's evidence names the city; a stated geography that STARTS with that same city (and carries no foreign marker) is the same city.
function sameCityAsEvidence(stated: string, evidence: string | null | undefined): boolean {
  const m = new RegExp(`${STREET.source}\\s*,\\s*([\\p{L}][\\p{L} .'-]{1,40})`, 'iu').exec(evidence ?? '')
  const city = m ? m[m.length - 1].trim().toLowerCase().replace(/\s+/g, ' ') : ''
  return !!city && !foreignMarker(stated) && stated.toLowerCase().replace(/\s+/g, ' ').startsWith(city)
}
const CA_PROVINCES = new Set(['on', 'qc', 'bc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe', 'yt', 'nt', 'nu', 'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick', 'newfoundland and labrador', 'prince edward island'])
const FOREIGN_COUNTRY = /\b(?:canada|mexico|united kingdom|great britain|england|scotland|wales|northern ireland|ireland|australia|new zealand|germany|france|spain|italy|netherlands|india|china|japan|brazil|south africa)\b/i
const CA_POSTAL = /\b[a-z]\d[a-z]\s?\d[a-z]\d\b/i
// A province, a Canadian postal code or a non-US/non-UK country name written in a stated place: the record is not in the lead's US city unless placeAgreement positively says otherwise.
function foreignMarker(stated: string): boolean {
  return CA_POSTAL.test(stated) || FOREIGN_COUNTRY.test(stated) || stated.split(/[,\s]+/).some((w, i, all) => i > 0 && CA_PROVINCES.has(w.toLowerCase()) && !(w.toLowerCase() === 'on' && all.length > 4)) || stated.split(',').some(seg => CA_PROVINCES.has(seg.trim().toLowerCase().replace(/\s+[a-z]\d[a-z].*$/i, '')))
}
export function contactAgreement(lead: LeadSide, c: Candidate): Agreement {
  const ld = registrable(lead.company_domain), cd = registrable(c.domain)
  if (ld && cd) return ld === cd ? { ok: true, via: 'domain' } : { ok: false, reason: `contact rejected: domain mismatch ${cd} vs ${ld}` }
  if (ld && !cd && c.keyedOnLeadDomain) return { ok: true, via: 'domain' }
  // A street address in the lead's own evidence is a basis: the same address agrees; a DIFFERENT one conflicts (unresolved, not attached) unless the domain already agreed.
  const addr = addressAgreement(c.address, lead.evidence)
  if (addr === 'agrees') {
    // A matching street number/name is NOT enough: whatever geography the record states (its place field, and everything the address writes after the street - city, region, postal code,
    // country) must AGREE with the lead's place, positively. A contradicting or merely unconfirmed city / region / country refuses ("57 W 57th St, Toronto, ON M5V 2T6, Canada" for a New York lead).
    // Only a record stating no geography at all falls back on the street match.
    const wh = effectiveWhere(lead)
    if (wh.length) for (const stated of [(c.place ?? '').trim(), addressGeography(c.address)]) {
      if (!stated) continue
      let v: 'agrees' | 'mismatch' | 'unconfirmed' | 'no_geography' = placeAgreement(stated, wh)
      if (v !== 'agrees' && foreignMarker(stated)) v = 'mismatch'
      // The same city the lead's own evidence writes after the same street ("57 W 57th St, New York"): a city agreement from the lead's evidence, when nothing contradicts it.
      else if (v === 'unconfirmed' && sameCityAsEvidence(stated, lead.evidence)) v = 'agrees'
      if (v !== 'agrees') return { ok: false, reason: `contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${stated.slice(0, 60)} vs ${leadPlaceLabel(wh).slice(0, 60)} (the street text matches, the city / region / country does not)` }
    }
    return { ok: true, via: 'address' }
  }
  if (addr === 'conflict') return { ok: false, reason: `contact rejected: address mismatch ${(streetKeys(c.address)[0] ?? 'another address').slice(0, 60)} vs ${(streetKeys(lead.evidence)[0] ?? 'the lead\'s address').slice(0, 60)}` }
  const place = (c.place ?? '').trim()
  const where = effectiveWhere(lead)
  if (where.length === 0) return { ok: true, via: 'no_geography' } // a request with no place makes no place demand (a domain that DISAGREES was refused above)
  if (!place) return { ok: false, reason: 'contact rejected: no domain or location to confirm the company' }
  const v = placeAgreement(place, where)
  if (v === 'agrees') return { ok: true, via: 'location' }
  const ours = leadPlaceLabel(where)
  // A bare country or a region is context, never a match for a city request.
  return { ok: false, reason: `contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${place.slice(0, 60)} vs ${ours.slice(0, 60)}` }
}
export { cityScoped }

// The first "City, ST" / "City, England" in a page, to name the other place in a refusal reason. Display only; never decides anything.
// Two-letter codes AND spelled-out names (all 50 + DC): "Pico Rivera, CA" and "Pico Rivera, California" are the same place.
const STATE_NAMES = [...Object.values(US_STATES)].map(n => n.replace(/\b\w/g, c => c.toUpperCase()).replace(/ Of /, ' of '))
const ST_ALT = [...Object.keys(US_STATES), ...STATE_NAMES].sort((x, y) => y.length - x.length).join('|')
const titleCase = (t: string) => t.replace(/(^|[\s-])(\p{L})/gu, (_, sp, c) => sp + c.toUpperCase()).replace(/ Of /, ' of ')
const LEAD_NOISE = /^(?:in|at|of|the|near|from|on|and|a|an|to|by)$/
const STATE_FULL = [...Object.values(US_STATES)].sort((x, y) => y.length - x.length).join('|')
const STATE_CODE_LC = Object.keys(US_STATES).map(k => k.toLowerCase()).join('|')
export function firstPlaceLabel(rawText: string, opts: { structured?: boolean } = {}): string | null {
  const text = rawText.replace(STREET, ' ')   // the street part ("57 W 57th St") is not a city: "St, Washington, District of Columbia" must read as Washington, District of Columbia
  const m = new RegExp(`\\b([A-Z][\\p{L}'.-]+(?: [A-Z][\\p{L}'.-]+){0,2}),\\s*(${ST_ALT})\\b(?:\\s+\\d{5})?`, 'u').exec(text)
  if (m) { const w = m[1].split(' '); while (w.length > 1 && /[a-z][A-Z]/.test(w[0])) w.shift(); return `${w.join(' ')}, ${m[2]}` }   // a leading camel-case word ("LinkedIn Pico Rivera") is page chrome, not part of the city
  // Casing never changes where a company is: the same address in lowercase or ALL CAPS is read the same. A spelled-out state name matches in any case; a two-letter code only when
  // upper-case above or, in lower case, when a ZIP follows (so "or" / "in" / "me" in running text are never read as a state). In a STRUCTURED address field (comma-separated, the
  // code is the last segment, optionally followed by a ZIP / USA) the lowercase code needs no ZIP: "57 w 57th st, pico rivera, ca".
  const lc = text.toLowerCase()
  const l = new RegExp(`(?<![\\p{L}])([\\p{L}'.-]+(?: [\\p{L}'.-]+){0,2}),\\s*(${STATE_FULL}|(?:${STATE_CODE_LC})(?=${opts.structured ? '\\s*(?:\\d{5}(?:-\\d{4})?\\s*)?(?:,\\s*(?:usa?|united states)\\s*)?$|\\s+\\d{5}\\b' : '\\s+\\d{5}\\b'}))(?![\\p{L}])`, 'u').exec(lc)
  if (l) { const w = l[1].split(' '); while (w.length > 1 && LEAD_NOISE.test(w[0])) w.shift(); const st = l[2].length === 2 ? l[2].toUpperCase() : titleCase(l[2]); return `${titleCase(w.join(' '))}, ${st}` }
  const u = /\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(England|Scotland|Wales|Northern Ireland|UK|United Kingdom|South Africa|Canada|Ontario)\b/u.exec(text)
  return u ? `${u[1]}, ${u[2]}` : null
}

// ---- the refusal is recorded on the lead, and the lead is regraded from the evidence actually kept ----
export const REJECTED_KIND = 'contact_rejected'
// The structured marker stored beside a refusal (the enrichment's label): why the record was not attached.
export type RejectionCode = 'contact_address_mismatch' | 'contact_location_mismatch' | 'contact_location_unconfirmed' | 'contact_domain_mismatch' | 'contact_unconfirmed'
export function contactRejectionCode(reason: string): RejectionCode {
  if (/address mismatch/i.test(reason)) return 'contact_address_mismatch'
  if (/location mismatch/i.test(reason)) return 'contact_location_mismatch'
  if (/location unconfirmed/i.test(reason)) return 'contact_location_unconfirmed'
  if (/domain mismatch|organization mismatch/i.test(reason)) return 'contact_domain_mismatch'
  return 'contact_unconfirmed'
}
const KEPT_KINDS = ['contact', 'person', 'email', 'phone']
// A refused record is kept as a labelled row beside the lead (shown on the card as the reason, never counted as a contact).
export function recordContactRejection(db: Database.Database, tenantId: string, leadId: string, r: { connector: string; reason: string; sourceUrl: string }): void {
  const url = /^https?:\/\//.test(r.sourceUrl) ? r.sourceUrl : 'https://invalid.example/'
  addEnrichment(db, tenantId, leadId, { connector: r.connector, kind: REJECTED_KIND, value: r.reason.slice(0, 254), label: contactRejectionCode(r.reason), confidence: null, source_url: url.slice(0, 500), source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
}
// "Can the seller act on it" (the action grade, 0-5) assumed a reachable company. When every contact found for a lead was refused (wrong place /
// wrong domain) and nothing else reaches it, reachability is unconfirmed: the grade is capped at 2 (it only ever goes DOWN) and the card says why.
// The list is ranked by fit, then action, so the lead drops below leads that do have a contact. Idempotent.
export const UNCONFIRMED_ACTION_CAP = 2
export function regradeFromKeptContacts(db: Database.Database, tenantId: string, jobId: string): number {
  const rows = db.prepare(
    `SELECT l.id, l.action, l.why, l.contact,
            (SELECT e.value FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.kind = '${REJECTED_KIND}' ORDER BY e.retrieved_at DESC LIMIT 1) AS rejected,
            (SELECT count(*) FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.kind IN (${KEPT_KINDS.map(k => `'${k}'`).join(',')})) AS kept
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.scan_job_id = ? AND j.user_id = ? AND l.action IS NOT NULL AND l.action > ${UNCONFIRMED_ACTION_CAP}`,
  ).all(tenantId, tenantId, jobId, tenantId) as { id: string; action: number; why: string | null; contact: string | null; rejected: string | null; kept: number }[]
  const upd = db.prepare('UPDATE leads SET action = ?, why = ? WHERE id = ?')
  let n = 0
  for (const r of rows) {
    if (!r.rejected || r.kept > 0 || (r.contact ?? '').trim()) continue
    const note = `Contact unconfirmed: ${r.rejected.replace(/^contact rejected:\s*/i, '')}. `
    upd.run(UNCONFIRMED_ACTION_CAP, (note + (r.why ?? '')).slice(0, WHY_MAX), r.id); n++
  }
  return n
}

// A search result that says which company a person works for must name THIS company. A name that is neither contained in nor containing the
// requested one, or a domain other than the one searched, contradicts it: the person is not attached. A result with no organization at all is not
// a contradiction (the search itself was keyed on the company's domain or name).
const compact = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/\b(inc|incorporated|ltd|limited|llc|llp|gmbh|corp|corporation|co|company|plc|pty|group|holdings|the)\b/g, ' ').replace(/[^a-z0-9]+/g, '')
export function organizationContradicts(company: string, searchedDomain: string | null | undefined, org: { name: string | null; domain: string | null } | null | undefined): string | null {
  if (!org) return null
  const sd = registrable(searchedDomain), od = registrable(org.domain)
  if (sd && od && sd !== od) return `contact rejected: organization mismatch ${od} vs ${sd}`
  if (org.name) {
    const a = compact(company), b = compact(org.name)
    if (a.length >= 3 && b.length >= 3 && !a.includes(b) && !b.includes(a)) return `contact rejected: organization mismatch ${org.name.slice(0, 60)} vs ${company.slice(0, 60)}`
  }
  return null
}
