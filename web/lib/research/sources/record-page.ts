// MISSION v2 part E: the registry records E's sources cite (lib/research/sources/socrata-permits.ts, opendatasoft-licences.ts), as readable
// pages. A source's Candidate points at the record's own open-data API JSON (the permit's human page is behind a captcha); the read and verify
// stages open it through the shared page fetcher (lib/scan/fetch-page.ts), which reads no JSON but the records it knows. This module tells the
// fetcher which URLs are such records and renders exactly that record as one sentence: the business, the record's number, what it is and the
// day the record states, side by side, so a quote cut from it carries its own date. A body that is not the record the URL names renders null.
import { looksLikePerson } from './socrata-permits.ts'
import { licenceDay, licenceLife } from './opendatasoft-licences.ts'

export type RegistryRecordRef = { kind: 'austin-permit'; id: string } | { kind: 'vancouver-licence'; id: string }

const AUSTIN = 'https://data.austintexas.gov/resource/3syk-w9eu.json'
const VANCOUVER = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences/records'
export function registryRecordRef(raw: string): RegistryRecordRef | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null
  const base = `${u.origin}${u.pathname}`, keys = [...u.searchParams.keys()]
  if (base === AUSTIN && keys.length === 1 && keys[0] === 'permit_number') {
    const id = u.searchParams.get('permit_number') ?? ''
    return /^\d{4}-\d{6} [A-Z]{2}$/.test(id) ? { kind: 'austin-permit', id } : null
  }
  if (base === VANCOUVER && keys.every(k => k === 'where' || k === 'limit') && keys.includes('where')) {
    const m = /^licencenumber="(\d{2}-\d{6})"$/.exec(u.searchParams.get('where') ?? '')
    return m ? { kind: 'vancouver-licence', id: m[1] } : null
  }
  return null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '')
const day = (v: unknown): string | null => { const d = str(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null }
// the sentence within the evidence quote limit: optional facts drop first, never the name, the number or the day
const cap = (s: string) => s.slice(0, 100)   // a name never pushes the sentence past the quote limit
const fit = (make: (facts: string[]) => string, facts: string[]) => {
  for (let n = facts.length; n >= 0; n--) { const t = make(facts.slice(0, n)); if (t.length <= 300) return t }
  return make([])
}

// What a registry record states, as fields (the verify path re-reads these; the page text below is rendered from the same fields, so the
// sentence a quote is cut from and the citation a proof carries can never drift apart).
export interface RegistryRecordFacts {
  kind: RegistryRecordRef['kind']
  id: string                       // the permit / licence number
  company: string                  // the business the record names: Austin, the general contractor; Vancouver, the trade name, else the legal name
  date: string                     // YYYY-MM-DD, the record's own issue day (Vancouver's local day)
  description: string              // what the record is for: the permit's work description / the licence's type ('' when the record states none)
  place: string | null             // where, with city and region
  person: string | null            // Austin: the contractor of record, only when it reads as a person
  licensee: string | null          // Vancouver: the legal name when it differs from the trade name
  revision: { number: string; date: string } | null   // Vancouver: the licence's current revision when it was amended after its first issue (`date` above is the FIRST issue)
  citation: string                 // "the city's open-data record, permit N, issued <date>": what a proof says (never "stated on the cited page")
}
// The facts of exactly the record the URL names, or null: another record, no business named, no valid day, an unissued licence.
export function registryRecordFacts(body: unknown, ref: RegistryRecordRef): RegistryRecordFacts | null {
  if (ref.kind === 'austin-permit') {
    // one row per contractor on the permit; every row must be this permit, and the general contractor's row names the company
    if (!Array.isArray(body) || !body.length || !body.every(r => isObj(r) && str(r.permit_number) === ref.id)) return null
    const rows = body as Record<string, unknown>[]
    // the permit's general contractor of record is the business the record is about; a permit with none names no business (never a sub's)
    const gc = rows.find(r => str(r.contractor_trade) === 'General Contractor' && str(r.contractor_company_name))
    // every row of one permit states the same issue day, or the record is not one dated fact
    const days = new Set(rows.map(r => day(r.issue_date)))
    const date = gc ? day(gc.issue_date) : null
    if (!gc || !date || days.size !== 1) return null
    const company = cap(str(gc.contractor_company_name).replace(/\*+\s*MAIN\s*\*+/gi, '').trim())
    if (!company) return null
    const at = str(gc.permit_location), person = looksLikePerson(str(gc.contractor_full_name)) ? cap(str(gc.contractor_full_name)) : ''   // never 'N/A' or a company as a person
    return { kind: ref.kind, id: ref.id, company, date, description: str(gc.description).slice(0, 300), place: at ? `${at}, Austin, Texas` : null, person: person || null, licensee: null, revision: null,
      citation: `the city's open-data record, permit ${ref.id}, issued ${date}` }
  }
  // Vancouver: {total_count, results: [...]}: every revision of this licence is a row; its current state is the single Issued row and its date is the FIRST issue
  const results = isObj(body) && Array.isArray(body.results) ? body.results.filter(isObj) : null
  const life = licenceLife(results?.filter(x => str(x.licencenumber) === ref.id) ?? [])
  if (!life) return null
  const r = life.current, date = life.first, legal = cap(str(r.businessname)), trade = cap(str(r.businesstradename)), company = trade || legal
  if (!company) return null
  const address = [str(r.unit) && `${str(r.unit)}-`, str(r.house), str(r.street)].filter(Boolean).join(' ').replace('- ', '-')
  const revisedOn = life.revisions > 1 ? licenceDay(r.issueddate) : null
  return { kind: ref.kind, id: ref.id, company, date, description: [str(r.businesstype), str(r.businesssubtype)].filter(Boolean).join(', '),
    place: address ? `${address}${str(r.localarea) ? `, ${str(r.localarea)}` : ''}, Vancouver, BC` : null, person: null, licensee: trade && legal && trade !== legal ? legal : null,
    revision: revisedOn && revisedOn !== date ? { number: life.revision, date: revisedOn } : null,
    citation: `the city's open-data record, licence ${ref.id}, issued ${date}` }
}

export interface RecordPage { text: string; title: string; published: string }
export function renderRegistryRecord(body: unknown, ref: RegistryRecordRef): RecordPage | null {
  const f = registryRecordFacts(body, ref)
  if (!f) return null
  if (f.kind === 'austin-permit') {
    const what = f.description.slice(0, 140)
    const text = fit(x => `City of Austin permit ${f.id} was issued on ${f.date} with ${f.company} as general contractor${x.length ? ` (${x.join('; ')})` : ''}.`,
      [what ? `work: ${what}` : '', f.place ? `at ${f.place}` : '', f.person ? `contractor of record: ${f.person}` : ''].filter(Boolean))
    return { text, title: `City of Austin permit ${f.id}: ${f.company}`, published: f.date }
  }
  const text = fit(x => `City of Vancouver business licence ${f.id} was ${f.revision ? 'first ' : ''}issued on ${f.date} to ${f.company}${x.length ? ` (${x.join('; ')})` : ''}.`,
    [f.revision ? `revision ${f.revision.number} issued ${f.revision.date}` : '', f.licensee ? `licensee: ${f.licensee}` : '', f.description ? `type: ${f.description}` : '', f.place ? `at ${f.place}` : ''].filter(Boolean))
  return { text, title: `City of Vancouver business licence ${f.id}: ${f.company}`, published: f.date }
}
