// MISSION v2 part E: the registry records E's sources cite (lib/research/sources/socrata-permits.ts, opendatasoft-licences.ts), as readable
// pages. A source's Candidate points at the record's own open-data API JSON (the permit's human page is behind a captcha); the read and verify
// stages open it through the shared page fetcher (lib/scan/fetch-page.ts), which reads no JSON but the records it knows. This module tells the
// fetcher which URLs are such records and renders exactly that record as one sentence: the business, the record's number, what it is and the
// day the record states, side by side, so a quote cut from it carries its own date. A body that is not the record the URL names renders null.
import { looksLikePerson } from './socrata-permits.ts'
import { licenceDay } from './opendatasoft-licences.ts'

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

export interface RecordPage { text: string; title: string; published: string }
export function renderRegistryRecord(body: unknown, ref: RegistryRecordRef): RecordPage | null {
  if (ref.kind === 'austin-permit') {
    // one row per contractor on the permit; every row must be this permit, and the general contractor's row names the company
    if (!Array.isArray(body) || !body.length || !body.every(r => isObj(r) && str(r.permit_number) === ref.id)) return null
    const rows = body as Record<string, unknown>[]
    // the permit's general contractor of record is the business the record is about; a permit with none names no business (never a sub's)
    const gc = rows.find(r => str(r.contractor_trade) === 'General Contractor' && str(r.contractor_company_name))
    // every row of one permit states the same issue day, or the record is not one dated fact
    const days = new Set(rows.map(r => day(r.issue_date)))
    const issued = gc ? day(gc.issue_date) : null
    if (!gc || !issued || days.size !== 1) return null
    const company = cap(str(gc.contractor_company_name).replace(/\*+\s*MAIN\s*\*+/gi, '').trim()), at = str(gc.permit_location), what = str(gc.description).slice(0, 140)
    if (!company) return null
    const person = looksLikePerson(str(gc.contractor_full_name)) ? cap(str(gc.contractor_full_name)) : ''   // never 'N/A' or a company as a person
    const text = fit(f => `City of Austin permit ${ref.id} was issued on ${issued} with ${company} as general contractor${f.length ? ` (${f.join('; ')})` : ''}.`,
      [what ? `work: ${what}` : '', at ? `at ${at}, Austin, Texas` : '', person ? `contractor of record: ${person}` : ''].filter(Boolean))
    return { text, title: `City of Austin permit ${ref.id}: ${company}`, published: issued }
  }
  // Vancouver: {total_count, results: [...]}: exactly the licence the URL names
  const results = isObj(body) && Array.isArray(body.results) ? body.results.filter(isObj) : null
  // exactly one row of this licence: several (a revision, a status change) do not state one licence's day and status
  const matches = results?.filter(x => str(x.licencenumber) === ref.id) ?? []
  if (matches.length !== 1) return null
  const r = matches[0]
  const issued = licenceDay(r.issueddate), legal = cap(str(r.businessname)), trade = cap(str(r.businesstradename)), name = trade || legal
  if (!issued || !name || str(r.status) !== 'Issued') return null
  const address = [str(r.unit) && `${str(r.unit)}-`, str(r.house), str(r.street)].filter(Boolean).join(' ').replace('- ', '-')
  const kind = [str(r.businesstype), str(r.businesssubtype)].filter(Boolean).join(', ')
  const text = fit(f => `City of Vancouver business licence ${ref.id} was issued on ${issued} to ${name}${f.length ? ` (${f.join('; ')})` : ''}.`,
    [trade && legal && trade !== legal ? `licensee: ${legal}` : '', kind ? `type: ${kind}` : '', address ? `at ${address}${str(r.localarea) ? `, ${str(r.localarea)}` : ''}, Vancouver, BC` : ''].filter(Boolean))
  return { text, title: `City of Vancouver business licence ${ref.id}: ${name}`, published: issued }
}
