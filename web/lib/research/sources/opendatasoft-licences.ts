// MISSION v2 part E: city business licences on Opendatasoft portals (Explore API v2.1) as a dated-by-construction source. First config:
// the City of Vancouver's business-licences dataset, category restaurants (matrix case vancouver-restaurants: "opening a second location").
//
// Measured on the real dataset (15 Nov 2026, 90 days): 78 restaurant licences issued; licences renew every year with a NEW licence id
// (0 of the 78 share an id with the prior year), so a renewal is the same business at the same address in the prior licence year (26 of 78).
// The rest are a business newly licensed at that address: a new opening (or a new owner of an existing restaurant, which the record cannot
// tell apart; the summary says "newly licensed", not "opened"). Of those, the ones whose business holds another licence elsewhere this year
// are an additional location (4 in that window); only those are called that.
//
// Three narrow queries, so every answer stays far under the guarded getter's 1 MB cap (the full two-year export is 1.6 MB):
//   1. this year's licences of the category issued inside the window;  2. last year's licences at those addresses (renewals);
//   3. this year's licences under those business names (how many locations each holds).
// No person: a licence names the business, not someone in it (the company step finds people). Never relabelled as another signal.
import type { SafeGet } from '../../sources/types.ts'
import { isRecord, looksLikeHtml } from '../../sources/types.ts'
import type { Candidate } from '../types.ts'
import type { RegistrySource } from './registry.ts'
import { caseMentions } from './registry.ts'

export interface LicenceDataset {
  id: string
  city: string; region: string; country: string
  where: RegExp          // the case's place words that mean this city
  api: string            // https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences
  explore: string        // the dataset's public table, for the record link
  categories: Record<string, { words: RegExp; types: string[]; noun: string; label: string }>
}

export const VANCOUVER_LICENCES: LicenceDataset = {
  id: 'vancouver', city: 'Vancouver', region: 'BC', country: 'CA', where: / vancouver /,
  api: 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences',
  explore: 'https://opendata.vancouver.ca/explore/dataset/business-licences/table/',
  categories: { restaurants: { words: / restaurants? /, types: ['Restaurant'], noun: 'restaurant', label: 'Restaurants / food service' } },
}

type Row = Record<string, unknown>
// one new licence, before it becomes a Candidate (internal)
export interface LicenceRecord { company: string; eventKind: 'new_location_licence' | 'additional_location_licence'; eventSummary: string; eventDate: string; licence: string; recordUrl: string; pageUrl: string; personName: null }
const FIELDS = 'folderyear,licencenumber,businessname,businesstradename,status,issueddate,unit,house,street,localarea,businesssubtype'
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '')
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const who = (r: Row) => key(str(r.businesstradename) || str(r.businessname))
const where = (r: Row) => key(`${str(r.unit)} ${str(r.house)} ${str(r.street)}`)
const addressText = (r: Row) => [str(r.unit) && `${str(r.unit)}-`, str(r.house), str(r.street)].filter(Boolean).join(' ').replace('- ', '-')
const day = (v: unknown): string | null => { const d = str(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? d : null }
// an Opendatasoft (ODSQL) string literal: double quotes, a quote inside doubled
const lit = (s: string) => `"${s.replace(/"/g, '""')}"`
const typeClause = (types: string[]) => `(${types.map(t => `businesstype=${lit(t)}`).join(' or ')})`

export function licenceQueries(d: LicenceDataset, category: string, since: string, year: string) {
  const c = d.categories[category]
  const url = (w: string) => `${d.api}/exports/json?${new URLSearchParams({ select: FIELDS, where: w })}`
  return {
    window: url(`${typeClause(c.types)} and folderyear=${lit(year)} and status="Issued" and issueddate >= date'${since}'`),
    renewals: (rows: Row[]) => url(`${typeClause(c.types)} and folderyear=${lit(String(Number(year) - 1).padStart(2, '0'))} and (${rows.map(r => `(house=${lit(str(r.house))} and street=${lit(str(r.street))})`).join(' or ')})`),
    // a business is named by its trade name when it has one, else by its legal name: match the same field the window row was named by
    locations: (rows: Row[]) => url(`${typeClause(c.types)} and folderyear=${lit(year)} and status="Issued" and (${[...new Set(rows.map(r => str(r.businesstradename) ? `businesstradename=${lit(str(r.businesstradename))}` : str(r.businessname) ? `businessname=${lit(str(r.businessname))}` : '').filter(Boolean))].join(' or ') || 'false'})`),
  }
}

// Pure: the window's licences, minus renewals, each with how many licensed locations its business holds this year.
export function licenceSignals(d: LicenceDataset, category: string, windowRows: Row[], priorYearRows: Row[], sameNameRows: Row[], since: string): LicenceRecord[] {
  const c = d.categories[category]
  if (!c) return []
  const renewed = new Set(priorYearRows.map(r => `${who(r)}|${where(r)}`))
  const locations = new Map<string, Set<string>>()
  for (const r of [...sameNameRows, ...windowRows]) { const k = who(r); if (k) locations.set(k, new Set([...(locations.get(k) ?? []), where(r)])) }
  const seen = new Set<string>(), out: LicenceRecord[] = []
  for (const r of windowRows) {
    const date = day(r.issueddate), k = who(r), a = where(r)
    if (!date || date < since || !k || !a || renewed.has(`${k}|${a}`) || seen.has(`${k}|${a}`)) continue
    seen.add(`${k}|${a}`)
    const n = locations.get(k)?.size ?? 1, name = str(r.businesstradename) || str(r.businessname), number = str(r.licencenumber)
    const at = `${addressText(r)}${str(r.localarea) ? ` (${str(r.localarea)})` : ''}`
    out.push({
      company: name, licence: number,
      eventKind: n >= 2 ? 'additional_location_licence' : 'new_location_licence',
      eventSummary: n >= 2
        ? `New ${c.noun} business licence ${number} issued ${date} at ${at}, ${d.city}; the business holds ${n} licensed ${c.noun} locations in ${d.city} this year`
        : `${name} newly licensed as a ${c.noun} at ${at}, ${d.city} (licence ${number}, issued ${date}; no licence for this business at this address last year)`,
      eventDate: date,
      // the readable record: this one licence as JSON on the open-data API; the human table for the person reading
      recordUrl: `${d.api}/records?${new URLSearchParams({ where: `licencenumber=${lit(number)}`, limit: '5' })}`,
      pageUrl: `${d.explore}?${new URLSearchParams({ q: number })}`,
      personName: null,
    })
  }
  return out.sort((a, b) => (a.eventKind === b.eventKind ? (a.eventDate < b.eventDate ? 1 : -1) : a.eventKind === 'additional_location_licence' ? -1 : 1))
}

export const licenceCandidate = (d: LicenceDataset, category: string, r: LicenceRecord): Candidate => ({
  url: r.recordUrl, title: `${r.company}: new ${d.categories[category].noun} business licence in ${d.city} (city licence record)`,
  snippet: `${r.company} - ${r.eventSummary}. Public licence table: ${r.pageUrl}`.slice(0, 600),
  date: r.eventDate, triggerId: `registry:${r.eventKind}`, query: `opendatasoft-licences:${d.id} ${category}`, via: 'registry', dated: 'registry',
})

async function getRows(http: SafeGet, url: string, notes: string[]): Promise<Row[] | null> {
  const res = await http(url, { accept: 'application/json' }).catch(() => null)
  if (!res) { notes.push('unreachable'); return null }
  if (res.status !== 200) { notes.push(res.status === 429 ? 'throttled' : `http_${res.status}`); return null }
  if (res.truncated) { notes.push('oversize'); return null }
  if (looksLikeHtml(res.body)) { notes.push('not_json'); return null }
  try { const j = JSON.parse(res.body); return Array.isArray(j) ? j.filter(isRecord) : (notes.push('not_json'), null) } catch { notes.push('not_json'); return null }
}

export function licencesSourceFor(d: LicenceDataset, now: () => Date = () => new Date()): RegistrySource {
  const category = (c: Parameters<RegistrySource['covers']>[0]) => Object.keys(d.categories).find(k => caseMentions(c, 'category', d.categories[k].words)) ?? null
  return {
    id: `opendatasoft-licences:${d.id}`,
    covers: c => caseMentions(c, 'where', d.where) && !!category(c),
    async collect(c, since, http) {
      const cat = category(c)
      if (!cat || !caseMentions(c, 'where', d.where)) return { candidates: [], notes: ['not_covered'] }
      const notes: string[] = []
      const year = String(now().getUTCFullYear() % 100).padStart(2, '0')
      const q = licenceQueries(d, cat, since, year)
      const win = await getRows(http, q.window, notes)
      if (!win || !win.length) return { candidates: [], notes }
      // without the prior year a renewal cannot be told from a new licence: fail closed (no records), never call a renewal new
      const prior = await getRows(http, q.renewals(win), notes)
      if (!prior) return { candidates: [], notes: [...notes, 'renewals_unknown'] }
      const same = await getRows(http, q.locations(win), notes) ?? (notes.push('locations_unknown'), [])
      return { candidates: licenceSignals(d, cat, win, prior, same, since).map(r => licenceCandidate(d, cat, r)), notes }
    },
  }
}
export const vancouverLicencesSource = licencesSourceFor(VANCOUVER_LICENCES)
