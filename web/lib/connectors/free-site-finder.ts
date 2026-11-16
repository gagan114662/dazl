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
export type FreeSiteHit = { url: string; source: 'wikidata' | 'openstreetmap'; ref: string }
export type FreeSiteDeps = { fetchImpl?: typeof fetch; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number }

const fold = (s: string): string => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '')
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

const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
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
  const search = rec(got.value)
  const ids = arr(search.search).map(rec).filter(h => sameCompanyName(company, str(h.label)) || sameCompanyName(company, str(rec(h.match).text))).map(h => str(h.id)).filter(id => /^Q\d+$/.test(id)).slice(0, 5)
  if (ids.length === 0) return { hits: [], outcome: 'empty' }
  const gotEnts = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${ids.join('|')}`, deps)
  if (!gotEnts.ok) return { hits: [], outcome: gotEnts.outcome }
  const ents = rec(rec(gotEnts.value).entities)
  const out: FreeSiteHit[] = []
  for (const id of ids) {
    const claims = arr(rec(rec(ents[id]).claims).P856)
    for (const c of claims) {
      const c1 = rec(c)
      if (str(c1.rank) === 'deprecated') continue
      const url = str(rec(rec(c1.mainsnak).datavalue).value)
      if (/^https?:\/\//i.test(url)) out.push({ url, source: 'wikidata', ref: `https://www.wikidata.org/wiki/${id}` })
    }
  }
  return { hits: out, outcome: out.length > 0 ? 'ok' : 'empty' }
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
  const rows = arr(got.value)
  const out: FreeSiteHit[] = []
  for (const r0 of rows) {
    const r = rec(r0)
    const names = [str(r.name), ...Object.values(rec(r.namedetails)).map(str)].filter(Boolean)
    if (!names.some(n => sameCompanyName(company, n))) continue
    const tags = rec(r.extratags)
    const url = str(tags.website) || str(tags['contact:website']) || str(tags.url)
    const full = /^https?:\/\//i.test(url) ? url : url && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : ''
    if (full) out.push({ url: full, source: 'openstreetmap', ref: `https://www.openstreetmap.org/${str(r.osm_type)}/${String(r.osm_id ?? '')}` })
  }
  return { hits: out, outcome: out.length > 0 ? 'ok' : 'empty' }
}

// Both sources, Wikidata first; each answer keeps the page it came from (ref) so the caller can audit where a site came from.
export async function freeCompanySites(company: string, where: string[], deps: FreeSiteDeps = {}): Promise<FreeSiteHit[]> {
  return (await freeCompanySitesDetailed(company, where, deps)).hits
}
// The same, with each source's outcome (1289-F3), so a failed or cancelled lookup is audited as such, not as "no match".
export async function freeCompanySitesDetailed(company: string, where: string[], deps: FreeSiteDeps = {}): Promise<{ hits: FreeSiteHit[]; outcomes: { wikidata: SourceOutcome; openstreetmap: SourceOutcome } }> {
  const wd = await wikidataAnswer(company, deps)
  const osm: SourceAnswer = deps.signal?.aborted ? { hits: [], outcome: 'cancelled' } : await osmAnswer(company, where, deps)
  return { hits: [...wd.hits, ...osm.hits], outcomes: { wikidata: wd.outcome, openstreetmap: osm.outcome } }
}

// test-only: forget the Nominatim pacing clock
export const resetFreeSiteFinderPacing = () => { lastNominatim = 0; nominatimTurn = Promise.resolve() }
