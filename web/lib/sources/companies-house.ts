// UK Companies House: new company incorporation as the "local opening" signal for UK local and small businesses (#764, part of #388; the owner chose this
// market and source on the issue). One dated official signal:
//  - new_company: an ACTIVE company incorporated in the window, filtered by SIC 2007 code and, when the request names one, the registered-office town/city.
// Spec (developer-specs.company-information.service.gov.uk, advanced-company-search): GET /advanced-search/companies; sic_codes comma-delimited; `hits` is typed string;
// 404 = "No companies found". Authorized access only: the official Companies House API (advanced company search) with the deployment's own free API key (COMPANIES_HOUSE_API_KEY, HTTP
// Basic with the key as the user name). No key = the source is UNAVAILABLE and reports credential_missing (a partial run), never an empty market, and nothing
// is requested. The key is only ever sent to api.company-information.service.gov.uk as a header: it is not placed in a URL, an Evidence item or a note.
// Each item cites the company's public page on find-and-update.company-information.service.gov.uk (robots.txt: none, page answers 200), read through the scan's
// own page reader. Fail closed: the page must show the company name next to its company number, status Active, and the SAME incorporation date the API gave -
// otherwise the item is dropped as page_mismatch. The date is the registry's own incorporation date, never a crawl time.
// Incorporation is an official filing, not proof a shop has opened: the title says "newly incorporated", never "opened".
import type { AdapterInput, Evidence, SourceAdapter } from './types.ts'

const API = 'https://api.company-information.service.gov.uk'
const PAGE = 'https://find-and-update.company-information.service.gov.uk/company'
// Per-scan budget: 1 list request + at most maxPages page reads; no request STARTS after budgetMs (each is hard-bounded at 10 s by the guarded getter).
// The advanced search has no sort, so one page of `size` rows is read and ordered newest-first locally; when the register holds more rows than were read the run
// says so ('truncated') instead of looking complete. Process-wide hourly cap like the other adapters (Companies House allows 600 requests / 5 min per key).
export const chLimits = { budgetMs: 12_000, windowDays: 30, maxPages: 6, size: 100, now: () => Date.now(), key: () => process.env.COMPANIES_HOUSE_API_KEY ?? '' }
const HOUR_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_COMPANIES_HOUSE_PER_HOUR || 60)
let calls: number[] = []
export const resetChState = () => { calls = [] }

const w = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'iu')
// Industry words -> SIC 2007 five-digit codes (the advanced search matches codes exactly).
export const CH_SECTORS: { id: string; words: RegExp; codes: string[] }[] = [
  { id: 'dental', words: w('dental|dentists?|orthodontists?|orthodontics'), codes: ['86230'] },
  { id: 'veterinary', words: w('vets?|veterinar(?:y|ians?)'), codes: ['75000'] },
  { id: 'restaurant', words: w('restaurants?|caf[eé]s?|coffee shops?|takeaways?|catering'), codes: ['56101', '56102', '56210'] },
  { id: 'pub_bar', words: w('pubs?|bars?|taverns?'), codes: ['56302'] },
  { id: 'hair_beauty', words: w('hair ?salons?|hairdressers?|barbers?|barbershops?|beauty salons?'), codes: ['96020'] },
  { id: 'fitness', words: w('gyms?|fitness (?:centers?|centres?|studios?)'), codes: ['93130'] },
  { id: 'construction', words: w('construction|builders?|building contractors?|general contractors?'), codes: ['41202', '43999'] },
  { id: 'plumbing', words: w('plumbers?|plumbing|heating engineers?'), codes: ['43220'] },
  { id: 'electrical', words: w('electricians?|electrical contractors?'), codes: ['43210'] },
  { id: 'cleaning', words: w('cleaning (?:companies|company|services?)|cleaners'), codes: ['81210', '81221', '81222', '81299'] },
  { id: 'accounting', words: w('accountants?|accounting firms?|bookkeep(?:ers?|ing)'), codes: ['69201', '69202', '69203'] },
  { id: 'legal', words: w('law firms?|lawyers?|solicitors?|attorneys?'), codes: ['69101', '69102', '69109'] },
  { id: 'real_estate', words: w('estate agents?|letting agents?|real estate|property management'), codes: ['68310', '68320', '68209'] },
  { id: 'software', words: w('software|saas|it consultanc(?:y|ies)|it services'), codes: ['62012', '62020', '62090'] },
]
export const CH_PLACES: { name: string; words: RegExp }[] = [
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Edinburgh', 'Bristol', 'Liverpool', 'Sheffield', 'Cardiff', 'Belfast', 'Newcastle', 'Nottingham', 'Leicester',
].map(name => ({ name, words: w(name.toLowerCase()) }))
const UK = w('uk|u\\.k\\.|united kingdom|britain|british|england|english|scotland|scottish|wales|welsh|northern ireland')
// Several UK city names are also US / Canadian towns ("Birmingham, AL", "London, ON"): a request that places the name there is not a UK request.
const ELSEWHERE_WORDS = /\b(?:usa|u\.s\.a?\.?|united states|canada|australia)\b|,\s*(?:alabama|alaska|arizona|california|colorado|connecticut|florida|georgia|illinois|kentucky|michigan|new hampshire|new york|ohio|ontario|oregon|pennsylvania|texas|virginia|washington)\b/i
const ELSEWHERE_CODES = /,\s*(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKNR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|BC|QC|NS|NB|MB|SK)\b/ // two-letter codes only when written upper-case

export interface ChScope { sector: string; codes: string[]; place: string | null; where: string }
// What this source can answer for a request, or null when it is outside coverage (no UK place / no mapped industry).
export function chScope(query: string): ChScope | null {
  if (ELSEWHERE_WORDS.test(query) || ELSEWHERE_CODES.test(query)) return null
  const place = CH_PLACES.find(p => p.words.test(query))
  if (!place && !UK.test(query)) return null
  const sector = CH_SECTORS.find(s => s.words.test(query))
  if (!sector) return null
  return { sector: sector.id, codes: sector.codes, place: place?.name ?? null, where: place?.name ?? 'the UK' }
}

interface ChAddress { locality?: string; region?: string; postal_code?: string; country?: string }
export interface ChCompany {
  company_name?: string; company_number?: string; company_status?: string; company_type?: string; date_of_creation?: string
  registered_office_address?: ChAddress; sic_codes?: string[]
}
const ISO = /^\d{4}-\d{2}-\d{2}$/
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
// Company types that are operating businesses; overseas entities, charities' CIOs, partnerships and the like are not a "new local business" signal here.
const OPERATING_TYPES = new Set(['ltd', 'plc', 'llp', 'private-unlimited', 'private-limited-guarant-nsc', 'private-limited-guarant-nsc-limited-exemption'])
const NUMBER = /^(?:\d{8}|[A-Z]{2}\d{6})$/

// Why a register entry is not a usable signal for this scope, or null when it is. Negative fixtures pin each reason.
export function chReject(c: ChCompany, scope: ChScope, from: string, today: string): 'bad_id' | 'status' | 'type' | 'sector' | 'place' | 'date' | null {
  if (!c.company_number || !NUMBER.test(c.company_number) || !c.company_name?.trim()) return 'bad_id'
  if (c.company_status !== 'active') return 'status'
  if (!OPERATING_TYPES.has(c.company_type ?? '')) return 'type'
  if (!(c.sic_codes ?? []).some(s => scope.codes.includes(s))) return 'sector'
  if (scope.place) {
    const a = c.registered_office_address, p = scope.place.toLowerCase()
    if (![a?.locality, a?.region].some(v => (v ?? '').toLowerCase().includes(p))) return 'place'
  }
  const d = c.date_of_creation ?? ''
  if (!ISO.test(d) || d < from || d > today) return 'date'
  return null
}

// An HTTP 200 is not proof the register answered: the envelope must be the documented shape (an object whose `items` is an array no longer than `hits`, or hits 0
// with no items). Anything else - {}, [], an error envelope, items that is not an array, more rows than hits - is a schema failure (a partial run), never a
// genuine empty market. A row is kept only when every field this adapter reads has the documented type; a malformed row is dropped and counted.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string'
export function isChCompany(v: unknown): v is ChCompany {
  if (!isObj(v) || typeof v.company_number !== 'string' || typeof v.company_name !== 'string') return false
  const a = v.registered_office_address
  return optStr(v.company_status) && optStr(v.company_type) && optStr(v.date_of_creation)
    && (a === undefined || a === null || (isObj(a) && optStr(a.locality) && optStr(a.region) && optStr(a.postal_code) && optStr(a.country)))
    && (v.sic_codes === undefined || v.sic_codes === null || (Array.isArray(v.sic_codes) && v.sic_codes.every(s => typeof s === 'string')))
}
export function chList(v: unknown): { rows: ChCompany[]; invalid: number; hits: number } | null {
  if (!isObj(v) || 'errors' in v || 'error' in v) return null
  // the spec types `hits` as a string ("The number of matches found"): a numeric string is the documented form, a number is tolerated, anything else is not an answer
  const hits = typeof v.hits === 'string' && /^\d{1,9}$/.test(v.hits) ? Number(v.hits) : v.hits
  if (typeof hits !== 'number' || !Number.isInteger(hits) || hits < 0) return null
  if (v.items === undefined) return hits === 0 ? { rows: [], invalid: 0, hits } : null
  if (!Array.isArray(v.items) || v.items.length > hits || (v.items.length === 0 && hits !== 0)) return null
  const rows = v.items.filter(isChCompany)
  return { rows, invalid: v.items.length - rows.length, hits }
}

export const chCandidates = (scope: ChScope, rows: ChCompany[], from: string, today: string): ChCompany[] =>
  rows.filter(c => !chReject(c, scope, from, today)).sort((a, b) => (b.date_of_creation! > a.date_of_creation! ? 1 : b.date_of_creation! < a.date_of_creation! ? -1 : 0))

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
// What the company's own public page shows, or null when it does not show this company (fail closed): the name directly before "Company number N", status
// Active, and the incorporation date. `quote` is the passage naming the company next to its number; `date` is the page's own incorporation date.
export function chPageFacts(pageText: string, name: string, number: string): { quote: string; date: string } | null {
  const text = pageText.replace(/\s+/g, ' ')
  const nm = name.replace(/\s+/g, ' ').trim()
  const anchor = `${nm} Company number ${number}`
  const at = text.indexOf(anchor)
  if (at < 0 || nm.length + 16 + number.length < 20) return null
  if (!/ Company status Active\b/.test(text)) return null
  const m = /\bIncorporated on (\d{1,2}) ([A-Z][a-z]+) (\d{4})\b/.exec(text)
  const mi = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1
  if (!m || mi < 0) return null
  const date = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  let quote = text.slice(at, at + 300)
  const cut = quote.indexOf(' Follow this company'); if (cut > 0) quote = quote.slice(0, cut)
  if (quote.length === 300) quote = quote.slice(0, quote.lastIndexOf(' '))
  return { quote: quote.trim(), date }
}

export const companiesHouseAdapter: SourceAdapter = {
  id: 'companies-house',
  label: 'UK Companies House',
  async collect({ query, http, page, note }: AdapterInput): Promise<Evidence[]> {
    const scope = chScope(query)
    if (!scope) { note?.('out_of_coverage'); return [] }
    const key = chLimits.key().trim()
    if (!key) { note?.('credential_missing'); return [] }
    if (!page) { note?.('no_page_reader'); return [] }
    const t0 = Date.now()
    const now = chLimits.now(), today = day(now), from = day(now - chLimits.windowDays * 86_400_000)
    const t = Date.now(); calls = calls.filter(c => t - c < HOUR_MS)
    if (calls.length >= MAX_CALLS) { note?.('budget'); return [] }
    calls.push(t)
    const q = `incorporated_from=${from}&incorporated_to=${today}&sic_codes=${scope.codes.join(',')}&company_status=active${scope.place ? `&location=${encodeURIComponent(scope.place)}` : ''}&size=${chLimits.size}`
    const r = await http(`${API}/advanced-search/companies?${q}`, { accept: 'application/json', headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` } })
    if (!r) { note?.('unreachable'); return [] }
    if (r.status === 401 || r.status === 403) { note?.('auth_or_blocked'); return [] }
    if (r.status === 429) { note?.('throttled'); return [] }
    if (r.status === 404) return [] // documented answer of this endpoint: "404 No companies found" is a genuine empty market (any other non-200 is a failure to read)
    if (r.status !== 200) { note?.('unreachable'); return [] }
    if (r.truncated) { note?.('oversize'); return [] }
    let body: unknown
    try { body = JSON.parse(r.body) } catch { note?.('unparseable'); return [] }
    const read = chList(body)
    if (!read) { note?.('schema_invalid'); return [] }
    for (let i = 0; i < read.invalid; i++) note?.('schema_invalid_row')
    if (read.hits > read.rows.length + read.invalid) note?.('truncated') // the register holds more matches than the one page read
    const out: Evidence[] = []
    let cut = false
    for (const c of chCandidates(scope, read.rows, from, today).slice(0, chLimits.maxPages)) {
      if (Date.now() - t0 > chLimits.budgetMs) { cut = true; break }
      const number = c.company_number!, name = c.company_name!.trim()
      const url = `${PAGE}/${number}`
      const text = await page(url).catch(() => null)
      if (!text) { note?.('unreadable'); continue }
      const facts = chPageFacts(text, name, number)
      if (!facts || facts.date !== c.date_of_creation) { note?.('page_mismatch'); continue }
      const a = c.registered_office_address
      const where = [a?.locality, a?.region].find(v => v?.trim()) ?? scope.where
      out.push({ source: 'companies-house', url, title: `Newly incorporated in ${where}: ${name} (Companies House, incorporated ${facts.date}; SIC ${(c.sic_codes ?? []).filter(s => scope.codes.includes(s)).join(', ')} - ${scope.sector})`, quote: facts.quote, date: facts.date })
    }
    if (cut) note?.('budget')
    return out
  },
}
