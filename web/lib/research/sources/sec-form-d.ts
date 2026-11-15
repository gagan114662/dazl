// MISSION v2 part E: SEC Form D (a US company's notice that it sold securities in an exempt offering: a funding round) as a
// dated-by-construction source. Free EDGAR JSON: the full-text search index (efts.sec.gov) finds the window's new Form D filings by state and
// city, and each filing's own primary_doc.xml gives the industry, the amounts and the people named on it (executive officers, directors).
//
// Measured on the real index (15 Nov 2026, 90 days): 1,322 Form D filings with a Texas business address, 558 that mention Austin; of the
// sampled new (not amended) Austin filings a third were pooled investment funds or SPVs, the rest operating companies (Tenstorrent, ICON
// Technology, Expressable). So: new filings only (no D/A, no amendment), never an investment fund (industry Pooled Investment Fund, or
// the Investment Company Act exemptions 3(c)), the business address in the case's city, the industry group the case's category means.
//
// SEC fair access: at most 10 requests a second from one process (the pace below is shared by every scan) and a User-Agent that names us.
// The event is what the filing proves: "filed a new Form D on <day>, reporting $X sold", never "raised a Series A" (the form does not say).
import type { Candidate, ResearchCase } from '../types.ts'
import type { SafeGet } from '../../sources/types.ts'
import { isRecord, looksLikeHtml } from '../../sources/types.ts'
import type { RegistrySource } from './registry.ts'
import { caseMentions } from './registry.ts'

const SEARCH = 'https://efts.sec.gov/LATEST/search-index'
const ARCHIVE = 'https://www.sec.gov/Archives/edgar/data'
const UA = 'dazl-sources/1.0 (+https://dazl.ai)'
const PAGE = 100, MAX_PAGES = 6, MAX_FILINGS = 120
export const SEC_MIN_GAP_MS = 120   // < 10 requests a second, with room

// The case's category words -> Form D industry groups (the form's own list). A case whose category means none of them is not covered.
export const FORM_D_CATEGORIES: { words: RegExp; groups: string[] }[] = [
  { words: / (?:tech|technology|software|saas|startups?|ai|apps?|platforms?|developer tools?|cybersecurity|data) /, groups: ['Other Technology', 'Computers', 'Telecommunications'] },
  { words: / (?:fintech|payments?|insurtech|lending) /, groups: ['Other Technology', 'Other Banking and Financial Services', 'Insurance'] },
  { words: / (?:biotech|biotechnology|life sciences|pharma|pharmaceuticals?) /, groups: ['Biotechnology', 'Pharmaceuticals'] },
  { words: / (?:health ?care|healthtech|medtech|medical devices?|digital health) /, groups: ['Other Health Care', 'Hospitals and Physicians', 'Biotechnology'] },
  { words: / restaurants? /, groups: ['Restaurants'] },
  { words: / (?:manufacturing|manufacturers?) /, groups: ['Manufacturing'] },
  { words: / (?:energy|cleantech|climate tech|climate) /, groups: ['Other Energy', 'Energy Conservation', 'Environmental Services', 'Electric Utilities'] },
]

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL',
  georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}
const CODES = new Set(Object.values(STATES))
// "Austin, Texas" / "Austin, TX" / "Austin, TX, USA" -> { city: 'Austin', state: 'TX' }; anything else (no US state named) -> null
export function usCity(where: string): { city: string; state: string } | null {
  const parts = where.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length < 2 || !/^[A-Za-z][A-Za-z .'-]+$/.test(parts[0])) return null
  const p = parts[1].replace(/\./g, '').trim(), state = CODES.has(p.toUpperCase()) && p.length === 2 ? p.toUpperCase() : STATES[p.toLowerCase()]
  return state ? { city: parts[0], state } : null
}
export const formDGroups = (c: Pick<ResearchCase, 'category' | 'query' | 'where'>): string[] =>
  [...new Set(FORM_D_CATEGORIES.filter(x => caseMentions(c, 'category', x.words)).flatMap(x => x.groups))]

export function formDSearchUrl(city: string, state: string, since: string, today: string, from = 0): string {
  return `${SEARCH}?${new URLSearchParams({ q: `"${city}"`, forms: 'D', dateRange: 'custom', startdt: since, enddt: today, locationCodes: state, from: String(from) })}`
}
export const formDDocUrl = (cik: string, adsh: string, rendered = false) => `${ARCHIVE}/${Number(cik)}/${adsh.replace(/-/g, '')}/${rendered ? 'xslFormDX01/' : ''}primary_doc.xml`

export interface FormDHit { cik: string; adsh: string; company: string; fileDate: string; location: string }
// One search page -> the new (not amended) Form D filings whose business address is the case's city; fund exemptions (3(c)) out.
export function formDHits(page: unknown, city: string, state: string): { hits: FormDHit[]; total: number } {
  const h = isRecord(page) && isRecord(page.hits) ? page.hits : null
  const total = h && isRecord(h.total) && typeof h.total.value === 'number' ? h.total.value : 0
  const at = `${city}, ${state}`.toLowerCase(), out: FormDHit[] = []
  for (const x of h && Array.isArray(h.hits) ? h.hits : []) {
    const s = isRecord(x) && isRecord(x._source) ? x._source : null, id = isRecord(x) && typeof x._id === 'string' ? x._id : ''
    if (!s || s.file_type !== 'D' || !id) continue
    const items = Array.isArray(s.items) ? s.items.map(String) : []
    if (items.some(i => /^3C/i.test(i))) continue
    const locs = Array.isArray(s.biz_locations) ? s.biz_locations.map(String) : []
    const loc = locs.find(l => l.toLowerCase() === at)
    const cik = Array.isArray(s.ciks) ? String(s.ciks[0] ?? '') : '', date = typeof s.file_date === 'string' ? s.file_date : ''
    if (!loc || !/^\d{10}$/.test(cik) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const name = Array.isArray(s.display_names) ? String(s.display_names[0] ?? '') : ''
    out.push({ cik, adsh: id.split(':')[0], company: name.replace(/\s*\((?:CIK|[A-Z.]{1,6})\b[^)]*\)/g, '').trim(), fileDate: date, location: loc })
  }
  return { hits: out, total }
}

const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const tag = (xml: string, t: string): string[] => [...xml.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'g'))].map(m => decode(m[1].trim()))
const nameCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()) : s)

export interface FormDFiling { company: string; industry: string | null; amendment: boolean; fund: boolean; sold: number | null; offered: number | 'indefinite' | null; firstSale: string | null; person: { name: string; title: string } | null }
// The filing's own document (pure; the tests run it on recorded real filings).
export function parseFormD(xml: string): FormDFiling {
  const num = (v: string | undefined) => (v && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : null)
  const offeredText = tag(xml, 'totalOfferingAmount')[0]
  const people = tag(xml, 'relatedPersonInfo').map(p => ({
    name: [tag(p, 'firstName')[0], tag(p, 'lastName')[0]].filter(Boolean).map(nameCase).join(' '),
    roles: tag(p, 'relationship'), clar: tag(p, 'relationshipClarification')[0] ?? '',
  })).filter(p => /^[A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*)+$/.test(p.name))
  const exec = people.find(p => p.roles.includes('Executive Officer')) ?? null
  return {
    company: tag(xml, 'entityName')[0] ?? '',
    industry: tag(xml, 'industryGroupType')[0] ?? null,
    amendment: tag(xml, 'isAmendment')[0] === 'true',
    fund: tag(xml, 'investmentFundType').length > 0 || tag(xml, 'industryGroupType')[0] === 'Pooled Investment Fund',
    sold: num(tag(xml, 'totalAmountSold')[0]),
    offered: offeredText === undefined ? null : /indefinite/i.test(offeredText) ? 'indefinite' : num(offeredText),
    firstSale: tag(tag(xml, 'dateOfFirstSale')[0] ?? '', 'value')[0]?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ?? null,
    person: exec ? { name: exec.name, title: exec.clar || exec.roles.join(', ') } : null,
  }
}

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`)
export function formDCandidate(h: FormDHit, f: FormDFiling, category: string): Candidate {
  const company = f.company || h.company
  const amount = f.sold !== null && f.sold > 0 ? `, reporting ${usd(f.sold)} sold${typeof f.offered === 'number' ? ` of a ${usd(f.offered)} offering` : f.offered === 'indefinite' ? ' (offering size indefinite)' : ''}` : ''
  return {
    url: formDDocUrl(h.cik, h.adsh, true),
    title: `${company}: new SEC Form D filed ${h.fileDate} (${h.location})`,
    snippet: `${company} (${h.location}) filed a new Form D with the SEC on ${h.fileDate} (a notice of an exempt securities offering)${amount}${f.firstSale ? `; first sale ${f.firstSale}` : ''}; industry: ${f.industry}.${f.person ? ` Named on the filing: ${f.person.name}, ${f.person.title}.` : ''} Filing ${h.adsh}.`.slice(0, 600),
    date: h.fileDate, triggerId: 'registry:form_d_offering', query: `sec-form-d ${h.location} ${category}`, via: 'registry', dated: 'registry',
  }
}

// One pace for the whole process: every SEC request waits its turn (fair access: < 10 a second).
let nextSlot = 0
const secPace = async () => { const now = Date.now(), at = Math.max(now, nextSlot); nextSlot = at + SEC_MIN_GAP_MS; if (at > now) await new Promise(r => setTimeout(r, at - now)) }

export function secFormDSource(o: { pace?: () => Promise<void>; maxFilings?: number } = {}): RegistrySource {
  const pace = o.pace ?? secPace, maxFilings = o.maxFilings ?? MAX_FILINGS
  const get = async (http: SafeGet, url: string, accept: string) => { await pace(); return http(url, { accept, headers: { 'user-agent': UA } }).catch(() => null) }
  return {
    id: 'sec-form-d',
    covers: c => !!usCity(c.where) && formDGroups(c).length > 0,
    async collect(c, since, http) {
      const at = usCity(c.where), groups = formDGroups(c)
      if (!at || !groups.length) return { candidates: [], notes: ['not_covered'] }
      const notes: string[] = [], hits = new Map<string, FormDHit>()
      for (let p = 0; p < MAX_PAGES; p++) {
        const res = await get(http, formDSearchUrl(at.city, at.state, since, c.today, p * PAGE), 'application/json')
        if (!res || res.status !== 200 || res.truncated || looksLikeHtml(res.body)) { notes.push(!res ? 'unreachable' : res.status === 429 ? 'throttled' : res.status !== 200 ? `http_${res.status}` : res.truncated ? 'oversize' : 'not_json'); break }
        let page: unknown
        try { page = JSON.parse(res.body) } catch { notes.push('not_json'); break }
        const { hits: hs, total } = formDHits(page, at.city, at.state)
        for (const h of hs) { const had = hits.get(h.cik); if (!had || had.fileDate < h.fileDate) hits.set(h.cik, h) }
        if ((p + 1) * PAGE >= total) break
        if (p === MAX_PAGES - 1) notes.push('page_cap_reached')
      }
      if (notes.length && !hits.size) return { candidates: [], notes }
      const newest = [...hits.values()].sort((a, b) => (a.fileDate < b.fileDate ? 1 : -1))
      if (newest.length > maxFilings) notes.push('filing_cap_reached')
      const out: Candidate[] = []
      let unread = 0
      for (const h of newest.slice(0, maxFilings)) {
        const res = await get(http, formDDocUrl(h.cik, h.adsh), 'application/xml')
        if (!res || res.status !== 200 || res.truncated || !res.body.includes('<edgarSubmission')) { unread++; continue }
        const f = parseFormD(res.body)
        // the document decides: amended, a fund, or an industry the case does not mean -> not a candidate
        if (f.amendment || f.fund || !f.industry || !groups.includes(f.industry)) continue
        out.push(formDCandidate(h, f, c.category))
      }
      if (unread) notes.push(`unread_${unread}`)
      return { candidates: out, notes }
    },
  }
}
export const secFormD = secFormDSource()
