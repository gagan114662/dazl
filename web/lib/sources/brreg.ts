// Norway's public register of legal entities (Enhetsregisteret, Brønnøysundregistrene) - #388. Two dated official signals for local and
// small businesses in a non-English market:
//  - new_company: a business registered in the window, filtered by industry code (NACE / SN2025 prefix) and, when the request names one, the municipality;
//  - new_location: a new establishment (underenhet) of a business that was already registered at least parentMinAgeDays before it - an opening, not a formation.
// Free, keyless open data (NLOD 2.0) from data.brreg.no. Each item cites the entity's public page on virksomhet.brreg.no (robots: Allow /), read through the
// scan's own page reader; the quote is cut from that page around the organisation number, so the cited page itself shows the registry identity and the normal
// verifier re-reads the same page. The registry date is the source's own date for the registration (never a crawl time).
// A request outside this source's coverage (no Norwegian place, or no mapped industry) is reported as out of coverage, never as an empty market. Bankruptcy and
// liquidation estates (KONKURSBO, TVANGSAVVIKLINGSBO, DØDSBO), dissolving or deleted entities, other industries and other municipalities are dropped.
import type { AdapterInput, Evidence, SourceAdapter } from './types.ts'

const API = 'https://data.brreg.no/enhetsregisteret/api'
const PAGE = 'https://virksomhet.brreg.no/nb/oppslag'
// Per-scan budget: 2 list requests + at most maxParents parent lookups + at most maxPages page reads; no request STARTS after budgetMs (each is hard-bounded
// at 10 s by the guarded getter, so 12 + 10 < the 25 s adapter deadline). Process-wide hourly cap like the other adapters.
export const brregLimits = { budgetMs: 12_000, windowDays: 60, parentMinAgeDays: 180, maxParents: 4, maxPages: 6, size: 20, now: () => Date.now() }
const HOUR_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_BRREG_PER_HOUR || 60)
let calls: number[] = []
export const resetBrregState = () => { calls = [] }

const w = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'iu')
// Industry words (English and Norwegian) -> SN2025 code prefixes; every prefix was checked against the live register (Nov 2026) to return that industry.
export const BRREG_SECTORS: { id: string; words: RegExp; codes: string[] }[] = [
  { id: 'dental', words: w('dental|dentists?|orthodontists?|orthodontics|tannleger?|tannklinikk(?:er)?|tannregulering'), codes: ['86.23'] },
  { id: 'physiotherapy', words: w('physio(?:therapy|therapists?)?|fysioterap(?:i|eut|euter)'), codes: ['86.95'] },
  { id: 'veterinary', words: w('vets?|veterinar(?:y|ians?)|veterin[æa]r(?:er)?|dyreklinikk(?:er)?'), codes: ['75'] },
  { id: 'restaurant', words: w('restaurants?|caf[eé]s?|coffee shops?|bars?|catering|restauranter?|kaf[eé]er?|serveringssteder?'), codes: ['56'] },
  { id: 'hair_beauty', words: w('hair ?salons?|hairdressers?|barbers?|barbershops?|beauty salons?|fris[øo]r(?:er|salong(?:er)?)?|skjønnhetssalong(?:er)?'), codes: ['96.2'] },
  { id: 'fitness', words: w('gyms?|fitness (?:centers?|centres?|studios?)|treningssent(?:er|re)'), codes: ['93.13'] },
  { id: 'construction', words: w('construction|builders?|building contractors?|general contractors?|byggefirma(?:er)?|entrepren[øo]r(?:er)?'), codes: ['41', '43'] },
  { id: 'plumbing', words: w('plumbers?|plumbing|r[øo]rleggere?'), codes: ['43.22'] },
  { id: 'electrical', words: w('electricians?|electrical contractors?|elektrikere?|elektroinstallat[øo]r(?:er)?'), codes: ['43.21'] },
  { id: 'cleaning', words: w('cleaning (?:companies|company|services?)|cleaners|renhold(?:sbyr[åa](?:er)?)?'), codes: ['81.2'] },
  { id: 'accounting', words: w('accountants?|accounting firms?|bookkeep(?:ers?|ing)|regnskapsf[øo]rere?|regnskapsbyr[åa](?:er)?'), codes: ['69.2'] },
  { id: 'legal', words: w('law firms?|lawyers?|attorneys?|advokat(?:er|firma(?:er)?)?'), codes: ['69.1'] },
  { id: 'real_estate', words: w('real estate|property management|eiendom(?:sselskap(?:er)?|smegl(?:er|ere))?'), codes: ['68'] },
  { id: 'software', words: w('software|saas|it consultanc(?:y|ies)|it services|programvare|it-selskap(?:er)?|it-konsulent(?:er)?'), codes: ['62'] },
]
// Municipalities -> kommunenummer (2024 numbering; each checked against the live register to return that municipality).
export const BRREG_PLACES: { name: string; words: RegExp; kommune: string }[] = [
  { name: 'Oslo', words: w('oslo'), kommune: '0301' },
  { name: 'Bergen', words: w('bergen'), kommune: '4601' },
  { name: 'Trondheim', words: w('trondheim'), kommune: '5001' },
  { name: 'Stavanger', words: w('stavanger'), kommune: '1103' },
  { name: 'Kristiansand', words: w('kristiansand'), kommune: '4204' },
  { name: 'Tromsø', words: w('troms[øo]e?'), kommune: '5501' },
  { name: 'Bodø', words: w('bod[øo]e?'), kommune: '1804' },
]
const NORWAY = w('norway|norge|noreg|norwegian|norsk')

export interface BrregScope { sector: string; codes: string[]; kommune: string | null; place: string }
// What this source can answer for a request, or null when the request is outside its coverage (no Norwegian place / no mapped industry).
export function brregScope(query: string): BrregScope | null {
  const place = BRREG_PLACES.find(p => p.words.test(query))
  if (!place && !NORWAY.test(query)) return null
  const sector = BRREG_SECTORS.find(s => s.words.test(query))
  if (!sector) return null
  return { sector: sector.id, codes: sector.codes, kommune: place?.kommune ?? null, place: place?.name ?? 'Norway' }
}

interface Address { kommunenummer?: string; kommune?: string }
export interface BrregEntity {
  organisasjonsnummer?: string; navn?: string; registreringsdatoEnhetsregisteret?: string; overordnetEnhet?: string
  konkurs?: boolean; underAvvikling?: boolean; underTvangsavviklingEllerTvangsopplosning?: boolean; slettedato?: string
  organisasjonsform?: { kode?: string }; naeringskode1?: { kode?: string; beskrivelse?: string }
  forretningsadresse?: Address; beliggenhetsadresse?: Address
}
const ESTATE = /(?:KONKURSBO|TVANGSAVVIKLINGSBO|AVVIKLINGSBO|DØDSBO)\s*$/i
const ISO = /^\d{4}-\d{2}-\d{2}$/
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000

// Why a register entry is not a usable signal for this scope, or null when it is. Negative fixtures pin each reason.
export function brregReject(e: BrregEntity, scope: BrregScope, from: string, today: string): 'bad_id' | 'estate' | 'winding_down' | 'sector' | 'place' | 'date' | null {
  if (!e.organisasjonsnummer || !/^\d{9}$/.test(e.organisasjonsnummer) || !e.navn?.trim()) return 'bad_id'
  if (ESTATE.test(e.navn) || ['KBO', 'DBO'].includes(e.organisasjonsform?.kode ?? '')) return 'estate'
  if (e.konkurs || e.underAvvikling || e.underTvangsavviklingEllerTvangsopplosning || e.slettedato) return 'winding_down'
  const code = e.naeringskode1?.kode ?? ''
  if (!scope.codes.some(p => code === p || code.startsWith(p.includes('.') ? p : `${p}.`))) return 'sector'
  const addr = e.forretningsadresse ?? e.beliggenhetsadresse
  if (scope.kommune && addr?.kommunenummer !== scope.kommune) return 'place'
  const d = e.registreringsdatoEnhetsregisteret ?? ''
  if (!ISO.test(d) || d < from || d > today) return 'date'
  return null
}

// #615 review: an HTTP 200 is not proof the register answered. A list read counts only when its envelope has the documented shape:
// an object whose _embedded holds the endpoint's own collection as an array, or (Spring HAL omits _embedded on an empty page) no _embedded and
// page.totalElements === 0. Anything else - {}, [], null, an error envelope, the other endpoint's collection, a non-array collection - is a schema
// failure, reported as such (the run is partial), never a genuine empty market. Rows are kept only when every field this adapter reads has the
// documented type; a malformed row is dropped and reported, and the endpoint's other rows (and the other endpoint) are kept.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string'
const optBool = (v: unknown) => v === undefined || v === null || typeof v === 'boolean'
const optCode = (v: unknown) => v === undefined || v === null || (isObj(v) && optStr(v.kode) && optStr(v.beskrivelse))
const optAddr = (v: unknown) => v === undefined || v === null || (isObj(v) && optStr(v.kommunenummer) && optStr(v.kommune))
export function isBrregEntity(v: unknown): v is BrregEntity {
  return isObj(v) && typeof v.organisasjonsnummer === 'string' && typeof v.navn === 'string' && optStr(v.registreringsdatoEnhetsregisteret) && optStr(v.overordnetEnhet)
    && optBool(v.konkurs) && optBool(v.underAvvikling) && optBool(v.underTvangsavviklingEllerTvangsopplosning) && optStr(v.slettedato)
    && optCode(v.organisasjonsform) && optCode(v.naeringskode1) && optAddr(v.forretningsadresse) && optAddr(v.beliggenhetsadresse)
}
export function brregList(v: unknown, k: 'enheter' | 'underenheter'): { rows: BrregEntity[]; invalid: number } | null {
  if (!isObj(v) || 'error' in v || 'feilmelding' in v) return null
  if (v._embedded === undefined) return isObj(v.page) && v.page.totalElements === 0 ? { rows: [], invalid: 0 } : null
  const a = isObj(v._embedded) ? v._embedded[k] : undefined
  if (!Array.isArray(a)) return null
  const rows = a.filter(isBrregEntity)
  return { rows, invalid: a.length - rows.length }
}

export type BrregCandidate = { kind: 'new_company'; e: BrregEntity } | { kind: 'new_location'; e: BrregEntity; parent: BrregEntity }
// Sub-units whose parent must be looked up: kept, not a parent that is itself in this window's new-company list (that is a formation, not an opening).
export function unitsNeedingParent(units: BrregEntity[], companies: BrregEntity[], scope: BrregScope, from: string, today: string): BrregEntity[] {
  const listed = new Set(companies.map(c => c.organisasjonsnummer))
  return units.filter(u => !brregReject(u, scope, from, today) && !!u.overordnetEnhet && !listed.has(u.overordnetEnhet))
}
// The usable signals: new companies in scope, then openings whose parent is an active business registered long enough before the unit.
export function brregCandidates(scope: BrregScope, companies: BrregEntity[], units: BrregEntity[], parents: ReadonlyMap<string, BrregEntity>, from: string, today: string): BrregCandidate[] {
  const openings: BrregCandidate[] = []
  for (const u of unitsNeedingParent(units, companies, scope, from, today)) {
    const p = parents.get(u.overordnetEnhet!)
    if (!p || !p.navn || ESTATE.test(p.navn) || p.konkurs || p.underAvvikling || p.underTvangsavviklingEllerTvangsopplosning || p.slettedato) continue
    const pd = p.registreringsdatoEnhetsregisteret ?? ''
    if (!ISO.test(pd) || daysBetween(pd, u.registreringsdatoEnhetsregisteret!) < brregLimits.parentMinAgeDays) continue
    openings.push({ kind: 'new_location', e: u, parent: p })
  }
  const fresh: BrregCandidate[] = companies.filter(c => !brregReject(c, scope, from, today)).map(e => ({ kind: 'new_company', e }))
  return [...openings, ...fresh]
}

// The passage of the entity's own public page that names it next to its organisation number; null when the page does not show this entity (fail closed).
export function brregQuote(pageText: string, navn: string, orgnr: string): string | null {
  const text = pageText.replace(/\s+/g, ' ')
  const anchor = text.indexOf(`Organisasjonsnummer ${orgnr.slice(0, 3)} ${orgnr.slice(3, 6)} ${orgnr.slice(6)}`)
  if (anchor < 0) return null
  const start = text.lastIndexOf(navn.replace(/\s+/g, ' ').trim(), anchor)
  if (start < 0 || anchor - start > 200) return null
  let q = text.slice(start, start + 300)
  const stop = q.indexOf(' Søk i Virksomhetsopplysninger'); if (stop > 0) q = q.slice(0, stop)
  if (q.length === 300) q = q.slice(0, q.lastIndexOf(' '))
  q = q.trim()
  return q.length >= 20 ? q : null
}

export const brregAdapter: SourceAdapter = {
  id: 'brreg',
  label: 'Norway business register',
  async collect({ query, http, page, note }: AdapterInput): Promise<Evidence[]> {
    const scope = brregScope(query)
    if (!scope) { note?.('out_of_coverage'); return [] }
    if (!page) { note?.('no_page_reader'); return [] }
    const t0 = Date.now(); let cut = false
    const now = brregLimits.now(), today = day(now), from = day(now - brregLimits.windowDays * 86_400_000)
    const FAILED = Symbol('failed') // the read itself failed and was already reported (unreachable / oversize / unparseable / budget)
    const json = async (url: string): Promise<unknown> => {
      if (Date.now() - t0 > brregLimits.budgetMs) { cut = true; return FAILED }
      const t = Date.now(); calls = calls.filter(c => t - c < HOUR_MS)
      if (calls.length >= MAX_CALLS) { cut = true; return FAILED }
      calls.push(t)
      const r = await http(url, { accept: 'application/json' })
      if (!r || r.status !== 200) { note?.('unreachable'); return FAILED }
      if (r.truncated) { note?.('oversize'); return FAILED }
      if (typeof r.body !== 'string') { note?.('unparseable'); return FAILED }
      try { return JSON.parse(r.body) } catch { note?.('unparseable'); return FAILED }
    }
    const q = `naeringskode=${scope.codes.join(',')}${scope.kommune ? `&kommunenummer=${scope.kommune}` : ''}&fraRegistreringsdatoEnhetsregisteret=${from}&size=${brregLimits.size}&sort=registreringsdatoEnhetsregisteret,desc`
    const [cj, uj] = await Promise.all([json(`${API}/enheter?${q}`), json(`${API}/underenheter?${q}`)])
    const list = (v: unknown, k: 'enheter' | 'underenheter'): BrregEntity[] => {
      if (v === FAILED) return []
      const read = brregList(v, k)
      if (!read) { note?.('schema_invalid'); return [] }
      for (let i = 0; i < read.invalid; i++) note?.('schema_invalid_row')
      return read.rows
    }
    const companies = list(cj, 'enheter'), units = list(uj, 'underenheter')
    const parents = new Map<string, BrregEntity>()
    for (const u of unitsNeedingParent(units, companies, scope, from, today)) {
      const id = u.overordnetEnhet!
      if (parents.has(id)) continue
      if (parents.size >= brregLimits.maxParents) { cut = true; break }
      const p = await json(`${API}/enheter/${id}`)
      if (p === FAILED) { parents.set(id, {}); continue }
      // the parent's own record: the same row shape, and it must be the entity that was asked for
      if (!isBrregEntity(p) || p.organisasjonsnummer !== id) { note?.('schema_invalid'); parents.set(id, {}); continue }
      parents.set(id, p)
    }
    const out: Evidence[] = []
    for (const c of brregCandidates(scope, companies, units, parents, from, today).slice(0, brregLimits.maxPages)) {
      if (Date.now() - t0 > brregLimits.budgetMs) { cut = true; break }
      const id = c.e.organisasjonsnummer!, date = c.e.registreringsdatoEnhetsregisteret!
      const url = `${PAGE}/${c.kind === 'new_location' ? 'underenheter' : 'enheter'}/${id}`
      const text = await page(url).catch(() => null)
      if (!text) { note?.('unreadable'); continue }
      const quote = brregQuote(text, c.e.navn!, id)
      if (!quote) { note?.('page_mismatch'); continue }
      const where = (c.e.forretningsadresse ?? c.e.beliggenhetsadresse)?.kommune ?? scope.place
      const title = c.kind === 'new_location'
        ? `${c.parent.navn} registered a new establishment in ${where}: ${c.e.navn} (Enhetsregisteret, ${date}); the business itself has been registered since ${c.parent.registreringsdatoEnhetsregisteret}`
        : `New business registered in ${where}: ${c.e.navn} (${c.e.naeringskode1?.beskrivelse ?? scope.sector}; Enhetsregisteret, ${date})`
      out.push({ source: 'brreg', url, title, quote, date })
    }
    if (cut) note?.('budget')
    return out
  },
}
