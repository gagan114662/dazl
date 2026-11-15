// MISSION v2 part E: city open-data permits (Socrata SODA API) as a dated-by-construction source. Port of
// ~/work/proto/signal-index/austin_roofing.py, which gave 43 ready Austin roofing leads at $0 (13 Nov matrix: 0).
//
// One permit row = one contractor of record on one permit: company, a NAMED person, the issue date, the permit's public link.
// Measured on the real Austin dataset (3syk-w9eu, 15 Nov 2026, 90 days): a plain "ROOF" match returns 506 permits from 282 companies,
// mostly the electrician, plumber or solar installer on a remodel "with a new roof". The category rule is therefore strict, per city
// config: the permit must be PRIMARILY that kind of job (the description starts with it, e.g. "Express: Re-roof"), or the company's
// own name says it (a roofing company), and the contractor's trade must be the general trade; excluded words (solar, kW) always win.
// That keeps 40 companies (39 with a named person), every one a roofing contractor on hand reading.
//
// The signal is what the record proves and nothing more: "N roofing permits issued in <city> since <date>" (active roofing jobs),
// never "hiring" (SIGNAL_INDEX.md: the UI must describe the signal as it is).
import type { SafeGet } from '../../sources/types.ts'
import { isRecord, looksLikeHtml } from '../../sources/types.ts'
import type { Market, SignalSource, SourceSignal } from './types.ts'

export interface PermitDataset {
  id: string                       // adapter id suffix, e.g. 'austin'
  city: string; region: string; country: string
  url: string                      // the SODA resource, e.g. https://data.austintexas.gov/resource/3syk-w9eu.json
  fields: { date: string; company: string; person: string; trade: string; description: string; number: string; location: string; link: string; phone: string }
  generalTrade: string             // the trade value of a general contractor in this dataset
  categories: Record<string, PermitCategory>
}
export interface PermitCategory {
  eventKind: string                // 'roofing_permits'
  noun: string                     // 'roofing permit'
  label: string                    // 'Roofing contractors'
  serverLike: string               // a cheap server-side prefilter on the description (SoQL upper(...) like '%X%'); the strict rule runs here
  primary: RegExp                  // the description is primarily this job
  companyName: RegExp              // the company's own name says it
  exclude: RegExp                  // never this category, whatever else matches
}

export const AUSTIN_PERMITS: PermitDataset = {
  id: 'austin', city: 'Austin', region: 'TX', country: 'US',
  url: 'https://data.austintexas.gov/resource/3syk-w9eu.json',
  fields: { date: 'issue_date', company: 'contractor_company_name', person: 'contractor_full_name', trade: 'contractor_trade', description: 'description', number: 'permit_number', location: 'permit_location', link: 'link', phone: 'contractor_phone' },
  generalTrade: 'General Contractor',
  categories: {
    roofing: {
      eventKind: 'roofing_permits', noun: 'roofing permit', label: 'Roofing contractors', serverLike: 'ROOF',
      primary: /^\W*(?:express\s*[:\-]?\s*)?(?:residential\s+|commercial\s+)?(?:re-?roof|roof(?:ing)?\s+(?:replace|repair|over)|new\s+roof|tear[- ]off)/i,
      companyName: /\broof/i,
      exclude: /\b(?:solar|photovoltaic|pv)\b|\d+(?:\.\d+)?\s*kw\b/i,
    },
  },
}

const MAX_ROWS = 2000
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const day = (v: unknown): string | null => { const d = str(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? d : null }
// "Empire Roofing Companies LLC **MAIN**" -> "Empire Roofing Companies LLC"
const cleanCompany = (s: string) => s.replace(/\*+\s*MAIN\s*\*+/gi, '').replace(/[\s,]+$/, '').trim()
const companyKey = (s: string) => cleanCompany(s).toLowerCase().replace(/\b(?:llc|inc|ltd|co|corp|company|l\.l\.c\.?|lp)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, '')
// a contractor of record is a person's name: two to four words, letters only (the dataset sometimes holds a company or "N/A")
const looksLikePerson = (s: string) => /^[A-Za-z][A-Za-z'.-]+(?:\s+[A-Za-z][A-Za-z'.-]+){1,3}$/.test(s) && !/\b(?:llc|inc|ltd|roofing|construction|company|n\/?a|none)\b/i.test(s)
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())

export function permitQuery(d: PermitDataset, c: PermitCategory, since: string): string {
  const f = d.fields
  const select = [f.date, f.company, f.person, f.trade, f.description, f.number, f.location, f.link, f.phone].join(',')
  const where = `${f.date} >= '${since}T00:00:00' AND ${f.company} IS NOT NULL AND upper(${f.description}) like '%${c.serverLike}%'`
  return `${d.url}?${new URLSearchParams({ $select: select, $where: where, $order: `${f.date} DESC`, $limit: String(MAX_ROWS) })}`
}

// The category rule on one row (pure; the tests run it on recorded real rows).
export function permitMatches(d: PermitDataset, c: PermitCategory, row: Record<string, unknown>): boolean {
  const desc = str(row[d.fields.description]), company = cleanCompany(str(row[d.fields.company])), trade = str(row[d.fields.trade])
  if (!company || c.exclude.test(desc)) return false
  if (trade && trade !== d.generalTrade) return false
  return c.primary.test(desc) || c.companyName.test(company)
}

// One record per company: its latest matching permit, how many it holds in the window, and the person the permits name most often.
export function permitSignals(d: PermitDataset, category: string, rows: Record<string, unknown>[], since: string): SourceSignal[] {
  const c = d.categories[category]
  if (!c) return []
  const f = d.fields
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const r of rows) {
    const date = day(r[f.date])
    if (!date || date < since || !permitMatches(d, c, r)) continue
    const k = companyKey(str(r[f.company]))
    if (k.length < 3) continue
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const out: SourceSignal[] = []
  for (const rs of groups.values()) {
    rs.sort((a, b) => (day(b[f.date])! < day(a[f.date])! ? -1 : 1))
    const latest = rs[0]
    const people = new Map<string, number>()
    for (const r of rs) { const p = str(r[f.person]); if (looksLikePerson(p)) people.set(p, (people.get(p) ?? 0) + 1) }
    const person = [...people.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const link = latest[f.link]
    const url = isRecord(link) && typeof link.url === 'string' && /^https:\/\//.test(link.url) ? link.url : ''
    if (!url) continue // no public record to cite: not a source we can show
    const company = cleanCompany(str(latest[f.company]))
    out.push({
      source: `socrata-permits:${d.id}`, company, eventKind: c.eventKind,
      eventSummary: `${rs.length} ${c.noun}${rs.length === 1 ? '' : 's'} issued in ${d.city} since ${since}; latest ${str(latest[f.number])} at ${str(latest[f.location])}: ${str(latest[f.description]).slice(0, 140)}`,
      eventDate: day(latest[f.date])!, eventCount: rs.length, sourceUrl: url,
      personName: person ? titleCase(person) : null, personTitle: person ? `Contractor of record on the ${d.city} permit` : null, personSourceUrl: person ? url : null,
      phone: str(latest[f.phone]) || null, city: d.city, region: d.region, country: d.country, category: c.label,
    })
  }
  return out.sort((a, b) => b.eventCount - a.eventCount || (a.eventDate < b.eventDate ? 1 : -1))
}

export function socrataPermitsSource(datasets: PermitDataset[] = [AUSTIN_PERMITS]): SignalSource {
  const find = (m: Market) => datasets.find(d => d.city.toLowerCase() === m.city.toLowerCase() && d.region.toLowerCase() === m.region.toLowerCase() && d.country.toLowerCase() === m.country.toLowerCase() && !!d.categories[m.category])
  return {
    id: 'socrata-permits',
    label: 'City permits (open data)',
    covers: m => !!find(m),
    async collect(m, since, http: SafeGet) {
      const d = find(m)
      if (!d) return { signals: [], notes: ['not_covered'] }
      const res = await http(permitQuery(d, d.categories[m.category], since), { accept: 'application/json' }).catch(() => null)
      if (!res) return { signals: [], notes: ['unreachable'] }
      if (res.status !== 200) return { signals: [], notes: [res.status === 429 ? 'throttled' : `http_${res.status}`] }
      if (res.truncated) return { signals: [], notes: ['oversize'] }
      if (looksLikeHtml(res.body)) return { signals: [], notes: ['not_json'] }
      let rows: unknown
      try { rows = JSON.parse(res.body) } catch { return { signals: [], notes: ['not_json'] } }
      if (!Array.isArray(rows)) return { signals: [], notes: ['not_json'] }
      const notes = rows.length >= MAX_ROWS ? ['row_cap_reached'] : []
      return { signals: permitSignals(d, m.category, rows.filter(isRecord), since), notes }
    },
  }
}
