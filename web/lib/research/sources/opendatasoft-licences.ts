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
  id: 'vancouver', city: 'Vancouver', region: 'BC', country: 'CA', where: /^ vancouver (?:bc|british columbia)(?: canada)? $/,
  api: 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences',
  explore: 'https://opendata.vancouver.ca/explore/dataset/business-licences/table/',
  categories: { restaurants: { words: / restaurants? /, types: ['Restaurant'], noun: 'restaurant', label: 'Restaurants / food service' } },
}

type Row = Record<string, unknown>
// one new licence, before it becomes a Candidate (internal)
export interface LicenceRecord { company: string; eventKind: 'new_business_licence' | 'additional_location_licence'; eventSummary: string; eventDate: string; licence: string; recordUrl: string; pageUrl: string; personName: null }
const FIELDS = 'folderyear,licencenumber,licencerevisionnumber,businessname,businesstradename,status,issueddate,unit,house,street,localarea,businesssubtype'
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '')
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const who = (r: Row) => key(str(r.businesstradename) || str(r.businessname))
const where = (r: Row) => key(`${str(r.unit)} ${str(r.house)} ${str(r.street)}`)
const addressText = (r: Row) => [str(r.unit) && `${str(r.unit)}-`, str(r.house), str(r.street)].filter(Boolean).join(' ').replace('- ', '-')
// the licence's day where it was issued: the dataset stamps issueddate in UTC ("2026-09-29T01:30:00+00:00" is the 28th in Vancouver)
const LOCAL = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' })
export const licenceDay = (v: unknown): string | null => {
  const s = str(v), d = s.slice(0, 10)
  // the calendar day must exist (2026-02-30 never rolls over to March) and a timestamp must say its offset (no server-timezone guess)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) return null
  if (s.length === 10) return d
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return null
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : LOCAL.format(new Date(ms))   // a malformed instant (hour 25, second 60) is no day, never a thrown row
}
const day = licenceDay

// All the rows the dataset holds for ONE licence number. Every revision is its own row: revision 00 is the first issue, a later revision amends it
// (a rename, an owner, a fee) and the one before goes Inactive, so the licence's current state is its single Issued row, which must be the latest
// revision, and the day it was first issued is revision 00's. Anything that cannot be ordered or read is unknown, never guessed: a row with no
// revision number, one revision twice, no Issued row or several, an Issued row older than another revision, no revision 00 row, no valid day.
export function licenceLife(rows: Row[]): { current: Row; first: string; revision: string; revisions: number } | null {
  const issued = rows.filter(r => str(r.status) === 'Issued')
  const numbers = rows.map(r => str(r.licencerevisionnumber))
  if (issued.length !== 1 || numbers.some(n => !/^\d+$/.test(n)) || new Set(numbers.map(Number)).size !== rows.length) return null
  const current = issued[0], revision = str(current.licencerevisionnumber)
  if (numbers.some(n => Number(n) > Number(revision))) return null
  const now = day(current.issueddate), first = Number(revision) === 0 ? now : day(rows.find(r => Number(str(r.licencerevisionnumber)) === 0)?.issueddate)
  return first && now ? { current, first, revision, revisions: rows.length } : null
}
// an Opendatasoft (ODSQL) string literal: double quotes, a quote inside doubled
const lit = (s: string) => `"${s.replace(/"/g, '""')}"`
const typeClause = (types: string[]) => `(${types.map(t => `businesstype=${lit(t)}`).join(' or ')})`

export const CHUNK = 25   // OR clauses per request: every URL stays a few KB
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))
const yearsClause = (ys: string[]) => `(${ys.map(y => `folderyear=${lit(y)}`).join(' or ')})`
const prev = (y: string) => String((Number(y) + 99) % 100).padStart(2, '0')
// The licence years a window touches: since 2025-11-12 .. today 2026-02-10 -> ['25', '26'] (a licence issued in December 2025 is in folder 25).
export const licenceYears = (since: string, today: string): string[] => [...new Set([since, today].map(d => d.slice(2, 4)))]

export function licenceQueries(d: LicenceDataset, category: string, since: string, years: string[]) {
  const c = d.categories[category]
  const url = (w: string) => `${d.api}/exports/json?${new URLSearchParams({ select: FIELDS, where: w })}`
  const names = (rows: Row[]) => [...new Set(rows.flatMap(r => [str(r.businesstradename) && `businesstradename=${lit(str(r.businesstradename))}`, str(r.businessname) && `businessname=${lit(str(r.businessname))}`]).filter(Boolean))]
  return {
    window: url(`${typeClause(c.types)} and ${yearsClause(years)} and status="Issued" and issueddate >= date'${since}'`),
    // the year before each window year, at the window's addresses (any name: the name test runs here, on both of a licence's names)
    renewals: (rows: Row[]) => chunks([...new Set(rows.map(r => `(house=${lit(str(r.house))} and street=${lit(str(r.street))})`))]).map(ch =>
      url(`${typeClause(c.types)} and ${yearsClause([...new Set(years.map(prev))])} and (${ch.join(' or ')})`)),
    // every revision row of the window's REVISED licences (revision other than 00): the dataset keeps each revision of a licence number as its own
    // row, revision 00 (the first issue) goes Inactive when a later one is issued, so the day a licence was first issued is on that older row
    // (by licence number alone, as the record URL and the re-read ask: a licence number names one licence whatever its type)
    revisions: (rows: Row[]) => chunks([...new Set(rows.filter(r => Number(str(r.licencerevisionnumber)) > 0).map(r => str(r.licencenumber)).filter(Boolean))]).map(ch =>
      url(`(${ch.map(n => `licencenumber=${lit(n)}`).join(' or ')})`)),
    // the current licence year only ("N locations this year"), under the window's business names (trade or legal)
    locations: (rows: Row[]) => chunks(names(rows)).map(ch => url(`${typeClause(c.types)} and ${yearsClause(years.slice(-1))} and status="Issued" and (${ch.join(' or ')})`)),
  }
}

// Pure: the window's licences, minus renewals, each with how many licensed locations its business holds this year.
export function licenceSignals(d: LicenceDataset, category: string, windowRows: Row[], priorYearRows: Row[], sameNameRows: Row[], since: string, revisionRows: Row[] = []): LicenceRecord[] {
  const c = d.categories[category]
  if (!c) return []
  // a renewal: last year's licence at the same address under either of this licence's names (trade or legal), so a business that added or
  // changed its trade name is still a renewal, never "new"
  const namesOf = (r: Row) => [key(str(r.businesstradename)), key(str(r.businessname))].filter(Boolean)
  // a witness is a licence from BEFORE the window: when the window spans New Year, last year's folder also holds the window's own December
  // licences, and a licence is never its own renewal (no issue day, e.g. pending: still a licence that existed before)
  const renewed = new Set(priorYearRows.filter(r => !((day(r.issueddate) ?? '') >= since)).flatMap(r => namesOf(r).map(n => `${n}|${where(r)}`)))
  // locations per name (a licence counts under both its trade and its legal name); a window licence's count is its busiest name's
  const locations = new Map<string, Set<string>>()
  // every issued licence this year counts as a location, dated or not (the query already asks for status Issued in this licence year);
  // a licence without a valid issue day is only never a candidate itself (below)
  for (const r of [...sameNameRows, ...windowRows]) for (const k of namesOf(r)) locations.set(k, new Set([...(locations.get(k) ?? []), where(r)]))
  // a licence is NEW when its FIRST issue is inside the window: a licence first issued earlier whose later revision (a rename, an owner) fell inside it is
  // the same business as before, not a new one (measured live 15 Nov: 5 of 40 Vancouver restaurants "new in 90 days" were such revisions)
  const byNumber = new Map<string, Row[]>()
  for (const r of [...windowRows, ...revisionRows]) {
    const n = str(r.licencenumber), had = byNumber.get(n) ?? []
    if (!had.some(x => JSON.stringify(x) === JSON.stringify(r))) byNumber.set(n, [...had, r])   // the window and the revision exports both hold the current row: the same row once
  }
  const seen = new Set<string>(), out: LicenceRecord[] = []
  for (const r of windowRows) {
    const date = licenceLife(byNumber.get(str(r.licencenumber)) ?? [r])?.first ?? null, k = who(r), a = where(r)
    if (!date || date < since || !k || !a || namesOf(r).some(n => renewed.has(`${n}|${a}`)) || seen.has(`${k}|${a}`)) continue
    seen.add(`${k}|${a}`)
    const n = Math.max(1, ...namesOf(r).map(x => locations.get(x)?.size ?? 1)), name = str(r.businesstradename) || str(r.businessname), number = str(r.licencenumber)
    const at = `${addressText(r)}${str(r.localarea) ? ` (${str(r.localarea)})` : ''}`
    out.push({
      company: name, licence: number,
      eventKind: n >= 2 ? 'additional_location_licence' : 'new_business_licence',
      eventSummary: n >= 2
        ? `New ${c.noun} business licence ${number} issued ${date} at ${at}, ${d.city}; ${n} licensed ${c.noun} locations in ${d.city} this year under the name ${name}`
        : `${name} newly licensed as a ${c.noun} at ${at}, ${d.city} (licence ${number}, issued ${date}; no licence under this name at this address last year)`,
      eventDate: date,
      // the readable record: this one licence as JSON on the open-data API; the human table for the person reading
      recordUrl: `${d.api}/records?${new URLSearchParams({ where: `licencenumber=${lit(number)}`, limit: '20' })}`,   // every revision of one licence is a row
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

async function getRows(http: SafeGet, url: string | string[], notes: string[]): Promise<Row[] | null> {
  if (Array.isArray(url)) { const all: Row[] = []; for (const u of url) { const r = await getRows(http, u, notes); if (!r) return null; all.push(...r) } return all }
  const res = await http(url, { accept: 'application/json' }).catch(() => null)
  if (!res) { notes.push('unreachable'); return null }
  if (res.status !== 200) { notes.push(res.status === 429 ? 'throttled' : `http_${res.status}`); return null }
  if (res.truncated) { notes.push('oversize'); return null }
  if (looksLikeHtml(res.body)) { notes.push('not_json'); return null }
  try { const j = JSON.parse(res.body); return Array.isArray(j) ? j.filter(isRecord) : (notes.push('not_json'), null) } catch { notes.push('not_json'); return null }
}

export function licencesSourceFor(d: LicenceDataset): RegistrySource {
  const category = (c: Parameters<RegistrySource['covers']>[0]) => Object.keys(d.categories).find(k => caseMentions(c, 'category', d.categories[k].words)) ?? null
  return {
    id: `opendatasoft-licences:${d.id}`,
    covers: c => caseMentions(c, 'where', d.where) && !!category(c),
    async collect(c, since, http) {
      const cat = category(c)
      if (!cat || !caseMentions(c, 'where', d.where)) return { candidates: [], notes: ['not_covered'] }
      const notes: string[] = []
      const q = licenceQueries(d, cat, since, licenceYears(since, c.today))
      const win = await getRows(http, q.window, notes)
      if (!win || !win.length) return { candidates: [], notes }
      // without last year a renewal cannot be told from a new licence, and without this year's other licences an additional location cannot
      // be told from a single one: either unreadable -> no records (fail closed), never a renewal called new or a kind guessed
      const prior = await getRows(http, q.renewals(win), notes)
      if (!prior) return { candidates: [], notes: [...notes, 'renewals_unknown'] }
      const same = await getRows(http, q.locations(win), notes)
      if (!same) return { candidates: [], notes: [...notes, 'locations_unknown'] }
      // a revised licence's first issue is on an older row: unreadable -> no records (the first issue day is never guessed)
      const revs = await getRows(http, q.revisions(win), notes)
      if (!revs) return { candidates: [], notes: [...notes, 'revisions_unknown'] }
      return { candidates: licenceSignals(d, cat, win, prior, same, since, revs).map(r => licenceCandidate(d, cat, r)), notes }
    },
  }
}
export const vancouverLicencesSource = licencesSourceFor(VANCOUVER_LICENCES)
