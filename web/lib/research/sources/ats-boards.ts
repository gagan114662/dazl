// MISSION v2 part E: public ATS job boards (Greenhouse, Lever, Ashby) as a dated-by-construction source. These APIs are per company (there
// is no "every company hiring in Austin" list), so the boards come from the hunt itself: a search result on a board host
// (job-boards.greenhouse.io/<token>, jobs.lever.co/<token>, jobs.ashbyhq.com/<token>) names the board; its free public JSON then gives every
// open role with its own posting day (Greenhouse first_published, Lever createdAt, Ashby publishedAt) and location. A search hit on a job
// page is undated or index-dated; the board's record is the role's own day.
//
// One candidate per company: its roles located in the case's city first posted inside the window. The event is what the board proves:
// "N open roles in <city> posted since <day>" with the titles, nothing more. A board whose roles are all elsewhere or older gives nothing.
import type { Candidate, ResearchCase } from '../types.ts'
import type { SafeGet } from '../../sources/types.ts'
import { isRecord, looksLikeHtml } from '../../sources/types.ts'

export type Ats = 'greenhouse' | 'lever' | 'ashby'
export interface Board { ats: Ats; token: string; host?: 'eu' }
export const MAX_BOARDS = 15

// a search result's URL -> the board it belongs to (null for anything else)
export function boardOf(raw: string): Board | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:') return null
  const h = u.hostname.toLowerCase(), seg = u.pathname.split('/').filter(Boolean), tok = (s: string | undefined | null) => (s && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(s) ? s.toLowerCase() : null)
  if (/^(?:boards|job-boards)\.greenhouse\.io$/.test(h)) {   // EU boards (*.eu.greenhouse.io) have another API host: not read
    const t = seg[0] === 'embed' ? tok(u.searchParams.get('for')) : tok(seg[0])
    return t ? { ats: 'greenhouse', token: t } : null
  }
  if (h === 'jobs.lever.co' || h === 'jobs.eu.lever.co') { const t = tok(seg[0]); return t ? { ats: 'lever', token: t, ...(h.includes('.eu.') ? { host: 'eu' as const } : {}) } : null }
  if (h === 'jobs.ashbyhq.com') { const t = tok(seg[0]); return t ? { ats: 'ashby', token: t } : null }
  return null
}

export const boardApi = (b: Board): string =>
  b.ats === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs`
    : b.ats === 'lever' ? `https://api${b.host === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(b.token)}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.token)}`

export interface Role { title: string; location: string; posted: string; url: string; company: string | null }
const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const isoDay = (v: unknown): string | null => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}
// The board's JSON -> its roles (pure; the tests run it on recorded real boards). A body without the board's shape (an error object with
// status 200) is null: unreadable, never "no roles".
export function boardRoles(b: Board, body: unknown): Role[] | null {
  if (b.ats === 'lever' ? !Array.isArray(body) : !(isRecord(body) && Array.isArray(body.jobs))) return null
  const out: Role[] = []
  if (b.ats === 'greenhouse') {
    for (const j of isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []) {
      if (!isRecord(j)) continue
      const posted = isoDay(j.first_published)
      if (posted && typeof j.id === 'number') out.push({ title: str(j.title), location: isRecord(j.location) ? str(j.location.name) : '', posted, url: `https://job-boards.greenhouse.io/${b.token}/jobs/${j.id}`, company: str(j.company_name) || null })
    }
  } else if (b.ats === 'lever') {
    for (const j of Array.isArray(body) ? body : []) {
      if (!isRecord(j)) continue
      const cat = isRecord(j.categories) ? j.categories : {}
      const locs = [str(cat.location), ...(Array.isArray(cat.allLocations) ? cat.allLocations.map(str) : [])].filter(Boolean)
      const posted = isoDay(j.createdAt), url = str(j.hostedUrl)
      if (posted && /^https:\/\/jobs\.(?:eu\.)?lever\.co\//.test(url)) out.push({ title: str(j.text), location: [...new Set(locs)].join('; '), posted, url, company: null })
    }
  } else {
    for (const j of isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []) {
      if (!isRecord(j) || j.isListed === false) continue
      const addr = (a: unknown) => (isRecord(a) && isRecord(a.postalAddress) ? str(a.postalAddress.addressLocality) : '')
      const locs = [str(j.location), addr(j.address), ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.flatMap(s => (isRecord(s) ? [str(s.location), addr(s.address)] : [])) : [])].filter(Boolean)
      const posted = isoDay(j.publishedAt), url = str(j.jobUrl)
      if (posted && /^https:\/\/jobs\.ashbyhq\.com\//.test(url)) out.push({ title: str(j.title), location: [...new Set(locs)].join('; '), posted, url, company: null })
    }
  }
  return out
}

const ATS_NAME: Record<Ats, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' }
const pretty = (token: string) => token.replace(/[-_.]+/g, ' ').replace(/\b([a-z])/g, m => m.toUpperCase())
const STATE: Record<string, string> = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc',
  'british columbia': 'bc', alberta: 'ab', ontario: 'on', quebec: 'qc', manitoba: 'mb', saskatchewan: 'sk', 'nova scotia': 'ns', 'new brunswick': 'nb' }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The case's place ("Austin, Texas") as a test on a role's location: the city as a whole word, not inside another place ("Port Austin",
// "North Vancouver"), and, when the case names a region, that region too ("Austin, MN" is not Austin, Texas).
export const cityOf = (c: Pick<ResearchCase, 'where'>) => c.where.split(',')[0].trim()
export function placeTest(c: Pick<ResearchCase, 'where'>): ((location: string) => boolean) | null {
  const [city, region] = c.where.split(',').map(s => s.trim().toLowerCase())
  if (!city) return null
  const cityRe = new RegExp(`(?:^|[;,(/|]\\s*)${esc(city)}(?=$|[^a-z])`)
  const r = (region ?? '').replace(/\./g, '')
  const code = STATE[r] ?? (Object.values(STATE).includes(r) ? r : null), full = Object.keys(STATE).find(k => STATE[k] === code) ?? r
  const regionRe = r ? new RegExp(`(?:^|[^a-z])(?:${[full, code].filter(Boolean).map(x => esc(x!)).join('|')})(?=$|[^a-z])`) : null
  return loc => { const l = loc.toLowerCase(); return cityRe.test(l) && (!regionRe || regionRe.test(l)) }
}
export function boardCandidate(b: Board, roles: Role[], c: Pick<ResearchCase, 'where'>, since: string): Candidate | null {
  const city = cityOf(c), at = placeTest(c)
  if (!city || !at) return null
  const here = roles.filter(r => r.posted >= since && at(r.location)).sort((x, y) => (x.posted < y.posted ? 1 : -1))
  if (!here.length) return null
  const company = here.find(r => r.company)?.company ?? pretty(b.token), latest = here[0]
  const titles = [...new Set(here.map(r => r.title))]
  return {
    url: latest.url,
    title: `${company}: ${here.length} open role${here.length === 1 ? '' : 's'} in ${city} posted since ${since} (${ATS_NAME[b.ats]} job board)`,
    snippet: `${company} has ${here.length} open role${here.length === 1 ? '' : 's'} located in ${city} first posted on its ${ATS_NAME[b.ats]} job board since ${since}; latest: ${latest.title} (${latest.location}), posted ${latest.posted}${titles.length > 1 ? `; also: ${titles.slice(1, 6).join('; ')}` : ''}. Board: ${boardApi(b)}`.slice(0, 600),
    date: latest.posted, triggerId: 'registry:ats_open_roles', query: `ats-boards:${b.ats}/${b.token}`, via: 'registry', dated: 'registry',
  }
}

// The boards named by the hunt's own results -> one dated candidate per board with roles in the city in the window.
export async function boardCandidates(c: ResearchCase, found: Candidate[], since: string, http: SafeGet, max = MAX_BOARDS): Promise<{ candidates: Candidate[]; notes: string[] }> {
  const boards = new Map<string, Board>()
  for (const x of found) { const b = boardOf(x.url); if (b) boards.set(`${b.ats}:${b.token}`, b) }
  const notes: string[] = [], out: Candidate[] = []
  if (boards.size > max) notes.push('board_cap_reached')
  const fail: Record<string, number> = {}
  for (const b of [...boards.values()].slice(0, max)) {
    const res = await http(boardApi(b), { accept: 'application/json' }).catch(() => null)
    const why = !res ? 'unreachable' : res.status === 404 ? 'no_board' : res.status !== 200 ? `http_${res.status}` : res.truncated ? 'oversize' : looksLikeHtml(res.body) ? 'not_json' : null
    let body: unknown = null
    if (!why) try { body = JSON.parse(res!.body) } catch { body = null }
    if (why || body === null) { const k = why ?? 'not_json'; fail[k] = (fail[k] ?? 0) + 1; continue }
    const roles = boardRoles(b, body)
    if (!roles) { fail.not_json = (fail.not_json ?? 0) + 1; continue }
    const cand = boardCandidate(b, roles, c, since)
    if (cand) out.push(cand)
  }
  for (const [k, n] of Object.entries(fail)) notes.push(`${k}_${n}`)
  return { candidates: out, notes }
}
