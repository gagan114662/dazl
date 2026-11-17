// #1122: a lead's company website from FREE public data, no key and no paid search (Gagan, 15 Nov: no paid API except Claude).
// Two open sources, in order:
//   1. Wikidata: the company's item and its "official website" (property P856). Covers known companies (Mercury, beehiiv, Clark...).
//   2. OpenStreetMap (Nominatim): a mapped business named like the company in the request's place, and its `website` tag. Covers local
//      businesses (a dental practice, a roofer, a restaurant).
// A host found here is only a CANDIDATE, exactly like a web-search result: the caller keeps only hosts whose own name is the company's
// (companyHostsFromSearch), and the crawl still reads the homepage and refuses it unless the homepage names the company and the place
// agrees. Nothing here is trusted on its own and nothing here is ever an email address.
// Politeness: an identifying User-Agent on every request, Nominatim at most 1 request per second (its usage policy), a hard per-request
// timeout, and the caller's abort signal. A failure of either source never stops the crawl; it is reported as failed or cancelled per source (1289-F3).

export const FREE_SITE_UA = 'dazl-site-finder/1.0 (+https://dazl.ai/bot)'
const TIMEOUT_MS = 8_000
const MAX_BODY = 1_000_000
const NOMINATIM_GAP_MS = 1_100

export type SourceOutcome = 'ok' | 'empty' | 'failed' | 'cancelled'
export type SourceAnswer = { hits: FreeSiteHit[]; outcome: SourceOutcome }
export type FreeSiteHit = { url: string; source: 'wikidata' | 'openstreetmap' | 'websearch'; ref: string }
export type FreeSiteDeps = { fetchImpl?: typeof fetch; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number }

// 1289-F2 (round 3): accents fold to their base letter (NFKD, combining marks removed); any other letter or digit, in any script, is KEPT,
// never deleted, so "Müller Dental" is "Muller Dental" but never "Mller Dental".
const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, '')
// The ONE company key for the finder's answer cache and its public-record mark: the folded name with every word kept ("Group" included).
export const siteCompanyKey = (company: string): string => fold(company.trim())
// Legal and generic tails that do not change which company a name is ("Mercury Technologies, Inc." is "Mercury Technologies").
const TAIL = /[\s,]+(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|plc|pty|bv|srl|oy|ab)\.?$/i
const core = (s: string): string => { let n = s.trim(); for (let i = 0; i < 2; i++) { const c = n.replace(TAIL, ''); if (c === n) break; n = c } return fold(n) }
// The source's name for the thing is this company: the same name after folding, ignoring legal tails. Never a longer or shorter name
// ("Mercury Insurance" is not "Mercury"), so a same-word company is not offered.
export function sameCompanyName(company: string, other: string): boolean {
  const a = core(company), b = core(other)
  return a.length >= 3 && a === b
}

// 1289-F3: a lookup that could not be completed is never "no answer": the caller learns whether the source failed (HTTP error, bad
// JSON, timeout, oversize) or was cancelled (the scan's abort), apart from a source that answered and had nothing.
type Got = { ok: true; value: unknown } | { ok: false; outcome: 'failed' | 'cancelled' }
async function getJson(url: string, deps: FreeSiteDeps): Promise<Got> {
  if (deps.signal?.aborted) return { ok: false, outcome: 'cancelled' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { headers: { 'user-agent': FREE_SITE_UA, accept: 'application/json' }, signal: ctrl.signal })
    if (!res.ok) return { ok: false, outcome: 'failed' }
    const text = await res.text()
    if (text.length > MAX_BODY) return { ok: false, outcome: 'failed' }
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, outcome: deps.signal?.aborted ? 'cancelled' : 'failed' }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onAbort)
  }
}

// 1289-F3 (round 3): a parsed 200 answer is checked against the source's envelope before anything can be "empty".
const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})
const str = (x: unknown): string => (typeof x === 'string' ? x : '')

// Wikidata: search items by name (English), keep the ones whose label or alias is the company's name, read their official website.
export async function wikidataSites(company: string, deps: FreeSiteDeps = {}): Promise<FreeSiteHit[]> {
  return (await wikidataAnswer(company, deps)).hits
}
export async function wikidataAnswer(company: string, deps: FreeSiteDeps = {}): Promise<SourceAnswer> {
  const q = company.trim().slice(0, 120)
  if (core(q).length < 3) return { hits: [], outcome: 'empty' }
  const got = await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(q)}`, deps)
  if (!got.ok) return { hits: [], outcome: got.outcome }
  const search = got.value
  if (!isRec(search) || 'error' in search || !Array.isArray(search.search)) return { hits: [], outcome: 'failed' }   // an error object or the wrong shape
  const ids = search.search.filter(isRec).filter(h => sameCompanyName(company, str(h.label)) || sameCompanyName(company, str(rec(h.match).text))).map(h => str(h.id)).filter(id => /^Q\d+$/.test(id)).slice(0, 5)
  if (ids.length === 0) return { hits: [], outcome: search.search.length > 0 && !search.search.some(isRec) ? 'failed' : 'empty' }
  const gotEnts = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${ids.join('|')}`, deps)
  if (!gotEnts.ok) return { hits: [], outcome: gotEnts.outcome }
  const body = gotEnts.value
  if (!isRec(body) || 'error' in body || !isRec(body.entities)) return { hits: [], outcome: 'failed' }
  const ents = body.entities
  const out: FreeSiteHit[] = []
  let malformed = false
  for (const id of ids) {
    const ent = ents[id]
    if (!isRec(ent)) { malformed = true; continue }                  // the asked item is missing or not a record
    if ('missing' in ent) continue                                    // Wikidata says the item does not exist: a real "nothing"
    const claims = ent.claims
    if (Array.isArray(claims) && claims.length === 0) continue        // Wikidata writes "no claims" as []
    if (!isRec(claims)) { malformed = true; continue }
    if (claims.P856 === undefined) continue                          // no official website: a real "nothing"
    if (!Array.isArray(claims.P856)) { malformed = true; continue }
    for (const c of claims.P856) {
      if (!isRec(c)) { malformed = true; continue }
      if (str(c.rank) === 'deprecated') continue
      // 1289-F3 (round 4): check the snak's shape before reading its URL. "novalue"/"somevalue" are real statements with no URL.
      const snak = c.mainsnak
      if (!isRec(snak)) { malformed = true; continue }
      if (snak.snaktype === 'novalue' || snak.snaktype === 'somevalue') continue
      const dv = snak.datavalue
      if (!isRec(dv) || typeof dv.value !== 'string') { malformed = true; continue }
      const url = dv.value
      if (/^https?:\/\//i.test(url)) out.push({ url, source: 'wikidata', ref: `https://www.wikidata.org/wiki/${id}` })
    }
  }
  return { hits: out, outcome: out.length > 0 ? 'ok' : malformed ? 'failed' : 'empty' }   // valid partial results survive a malformed neighbour
}

let lastNominatim = 0
// 1289-F1: every Nominatim request in this process (any scan, any finder) is admitted through ONE queue: a caller waits for the one
// before it to be admitted, re-reads the shared clock, sleeps out the gap, and checks its abort at its turn. Two callers can never
// compute the same wait and start together.
let nominatimTurn: Promise<void> = Promise.resolve()
async function admitNominatim(deps: FreeSiteDeps): Promise<boolean> {
  const before = nominatimTurn
  let done!: () => void
  nominatimTurn = new Promise<void>(r => { done = r })
  try {
    await before
    if (deps.signal?.aborted) return false
    const now = deps.now ?? Date.now
    const wait = lastNominatim + NOMINATIM_GAP_MS - now()
    if (wait > 0) await (deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms))))(wait)
    if (deps.signal?.aborted) return false
    lastNominatim = now()
    return true
  } finally { done() }
}
// OpenStreetMap via Nominatim: "<company>, <place>", with the place's own tags; keep results named like the company that carry a website.
export async function osmSites(company: string, where: string[], deps: FreeSiteDeps = {}): Promise<FreeSiteHit[]> {
  return (await osmAnswer(company, where, deps)).hits
}
export async function osmAnswer(company: string, where: string[], deps: FreeSiteDeps = {}): Promise<SourceAnswer> {
  const name = company.trim().slice(0, 120)
  if (core(name).length < 3) return { hits: [], outcome: 'empty' }
  const place = (where[0] ?? '').trim().slice(0, 120)
  if (!(await admitNominatim(deps))) return { hits: [], outcome: 'cancelled' }
  const q = place ? `${name}, ${place}` : name
  const got = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&namedetails=1&limit=5&q=${encodeURIComponent(q)}`, deps)
  if (!got.ok) return { hits: [], outcome: got.outcome }
  const rows = got.value
  if (!Array.isArray(rows)) return { hits: [], outcome: 'failed' }   // Nominatim answers a list; an error object or any other shape is a failure
  const out: FreeSiteHit[] = []
  let malformed = false
  for (const r of rows) {
    if (!isRec(r)) { malformed = true; continue }
    const names = [str(r.name), ...Object.values(rec(r.namedetails)).map(str)].filter(Boolean)
    if (!names.some(n => sameCompanyName(company, n))) continue
    const tags = rec(r.extratags)
    const url = str(tags.website) || str(tags['contact:website']) || str(tags.url)
    const full = /^https?:\/\//i.test(url) ? url : url && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : ''
    if (full) out.push({ url: full, source: 'openstreetmap', ref: `https://www.openstreetmap.org/${str(r.osm_type)}/${String(r.osm_id ?? '')}` })
  }
  return { hits: out, outcome: out.length > 0 ? 'ok' : malformed ? 'failed' : 'empty' }
}

// #1122/#1037: a FREE web search (DuckDuckGo's no-JavaScript HTML results page), only for a company the two public records could not place
// (a small agency is rarely in Wikidata or on the map: "War Room", Toronto, 2026-11-16). No key, no charge. Its results are only CANDIDATES:
// the caller keeps a host only when its own name carries the company's (companyHostsFromSearch), and the crawl still reads the homepage
// and checks the place. One request per company; the same timeout, abort signal and identifying User-Agent as the other sources.
export function parseDuckDuckGoHtml(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']|<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result__a/gi)) {
    let href = (m[1] ?? m[2] ?? '').replace(/&amp;/g, '&')
    if (href.startsWith('//')) href = `https:${href}`
    try {
      const u = new URL(href, 'https://html.duckduckgo.com/')
      const target = u.hostname.endsWith('duckduckgo.com') ? u.searchParams.get('uddg') : u.href
      if (target && /^https?:\/\//i.test(target) && !out.includes(target)) out.push(target)
    } catch { /* not a link */ }
    if (out.length >= 10) break
  }
  return out
}
export async function webSearchAnswer(company: string, where: string[], deps: FreeSiteDeps = {}): Promise<SourceAnswer> {
  const name = company.trim().slice(0, 120)
  if (core(name).length < 3) return { hits: [], outcome: 'empty' }
  if (deps.signal?.aborted) return { hits: [], outcome: 'cancelled' }
  const q = `${name} ${(where[0] ?? '').trim().slice(0, 80)}`.replace(/\s+/g, ' ').trim()
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { headers: { 'user-agent': FREE_SITE_UA, accept: 'text/html' }, signal: ctrl.signal })
    if (!res.ok) return { hits: [], outcome: 'failed' }
    const text = await res.text()
    if (text.length > MAX_BODY) return { hits: [], outcome: 'failed' }
    const hits = parseDuckDuckGoHtml(text).map(u => ({ url: u, source: 'websearch' as const, ref: url }))
    return { hits, outcome: hits.length > 0 ? 'ok' : 'empty' }
  } catch {
    return { hits: [], outcome: deps.signal?.aborted ? 'cancelled' : 'failed' }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onAbort)
  }
}

// Both sources, Wikidata first; each answer keeps the page it came from (ref) so the caller can audit where a site came from.
export async function freeCompanySites(company: string, where: string[], deps: FreeSiteDeps = {}): Promise<FreeSiteHit[]> {
  return (await freeCompanySitesDetailed(company, where, deps)).hits
}
// The same, with each source's outcome (1289-F3), so a failed or cancelled lookup is audited as such, not as "no match".
// #1122/#1037: the free web search runs last, only when asked for (deps.webSearch, the runner's finder) and neither public record gave a site.
export async function freeCompanySitesDetailed(company: string, where: string[], deps: FreeSiteDeps & { webSearch?: boolean } = {}): Promise<{ hits: FreeSiteHit[]; outcomes: { wikidata: SourceOutcome; openstreetmap: SourceOutcome; websearch?: SourceOutcome } }> {
  const wd = await wikidataAnswer(company, deps)
  const osm: SourceAnswer = deps.signal?.aborted ? { hits: [], outcome: 'cancelled' } : await osmAnswer(company, where, deps)
  if (deps.webSearch !== true || wd.hits.length + osm.hits.length > 0) return { hits: [...wd.hits, ...osm.hits], outcomes: { wikidata: wd.outcome, openstreetmap: osm.outcome } }
  const ws: SourceAnswer = deps.signal?.aborted ? { hits: [], outcome: 'cancelled' } : await webSearchAnswer(company, where, deps)
  return { hits: [...wd.hits, ...osm.hits, ...ws.hits], outcomes: { wikidata: wd.outcome, openstreetmap: osm.outcome, websearch: ws.outcome } }
}

// test-only: forget the Nominatim pacing clock
export const resetFreeSiteFinderPacing = () => { lastNominatim = 0; nominatimTurn = Promise.resolve() }
