// Public ATS job boards (Greenhouse, Lever, Ashby): a board URL -> the board, its free public JSON API, and its roles with their own
// posting day and location. Used by the company-first board postings (lib/company-first/board-postings.ts) and the runner's board
// detection. Moved here from the deleted research engine (lib/research/sources/ats-boards.ts, #1393); behaviour unchanged.
import { isRecord } from './types.ts'

export type Ats = 'greenhouse' | 'lever' | 'ashby'
export interface Board { ats: Ats; token: string; host?: 'eu' }

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
    : b.ats === 'lever' ? `${b.host === 'eu' ? 'https://api.eu.lever.co/v0/postings/' : 'https://api.lever.co/v0/postings/'}${encodeURIComponent(b.token)}?mode=json`
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
      const addr = (a: unknown) => (isRecord(a) && isRecord(a.postalAddress) ? [str(a.postalAddress.addressLocality), str(a.postalAddress.addressRegion)].filter(Boolean).join(', ') : '')
      const locs = [str(j.location), addr(j.address), ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.flatMap(s => (isRecord(s) ? [str(s.location), addr(s.address)] : [])) : [])].filter(Boolean)
      const posted = isoDay(j.publishedAt), url = str(j.jobUrl)
      if (posted && /^https:\/\/jobs\.ashbyhq\.com\//.test(url)) out.push({ title: str(j.title), location: [...new Set(locs)].join('; '), posted, url, company: null })
    }
  }
  return out
}
