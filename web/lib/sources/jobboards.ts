import type { Evidence, SourceAdapter, SafeGet } from './types.ts'
import { decodeText } from './rss.ts'

// Public job-board JSON (Greenhouse, Ashby). Evidence only: a posting says a company is hiring a role in a state.
// It is not proof of a need; the normal verifier still checks every lead against the cited page.
// Dates: Greenhouse `first_published` and Ashby `publishedAt` only. `updated_at` is never used as the posting date.
// Only the two documented API hosts are ever requested, and only for board tokens that pass a strict pattern.
const STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' }
const WINDOW_DAYS = 90
const MAX_DETAIL = 3 // per Greenhouse board
const MAX_BOARDS = 10
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const GENERIC = new Set(['hiring', 'roles', 'role', 'jobs', 'job', 'open', 'openings', 'positions', 'position', 'team', 'remote'])

export function stateIn(query: string): string | null {
  const q = query.toLowerCase()
  for (const [, name] of Object.entries(STATES)) if (new RegExp(`\\b${name.toLowerCase()}\\b`).test(q)) return name
  return null
}
export function locationInState(state: string, ...locs: (string | undefined)[]): boolean {
  const abbr = Object.keys(STATES).find(k => STATES[k] === state)!
  return locs.some(l => !!l && (new RegExp(`\\b${state}\\b`, 'i').test(l) || new RegExp(`,\\s*${abbr}\\b`).test(l) || l.trim() === abbr))
}
// The quote is a sentence of the posting's own body text as the API returns it (never title + location joined: a
// real posting page shows those in separate elements). No usable body text means no evidence, nothing is invented.
export function bodyQuote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = decodeText(decodeText(raw)) // Greenhouse returns escaped HTML: unescape, then strip tags
  const first = text.match(/^(.{20,300}?[.!?])(\s|$)/)?.[1]
  const q = first ?? (text.length >= 20 ? text.slice(0, 300).replace(/\s+\S*$/, '') : '')
  return q.length >= 20 ? q : null
}
const day = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}
const fresh = (d: string | null) => !!d && Date.now() - Date.parse(d) <= WINDOW_DAYS * 86_400_000 && Date.parse(d) <= Date.now() + 86_400_000
const json = async (http: SafeGet, url: string): Promise<any> => {
  const r = await http(url, { accept: 'application/json' })
  if (!r || r.status !== 200) return null
  try { return JSON.parse(r.body) } catch { return null }
}
function board(feed: string): { kind: 'gh' | 'ashby'; token: string } | null {
  let u: URL
  try { u = new URL(feed) } catch { return null }
  if (u.protocol !== 'https:' || u.search || u.hash || u.port || u.username || u.password) return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 1 || !TOKEN.test(parts[0]) || /%/.test(u.pathname)) return null
  if (u.hostname === 'boards.greenhouse.io' || u.hostname === 'job-boards.greenhouse.io') return { kind: 'gh', token: parts[0] }
  if (u.hostname === 'jobs.ashbyhq.com') return { kind: 'ashby', token: parts[0] }
  return null
}

const unesc = (t: string) => t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const LINK = /https:\/\/(?:boards|job-boards)\.greenhouse\.io\/[A-Za-z0-9_-]+|https:\/\/jobs\.ashbyhq\.com\/[A-Za-z0-9_-]+/g
// Board links from the newest monthly Hacker News "Who is hiring" thread (public Algolia API: one story lookup, one comments page).
// Only comments that name the state contribute boards. A link in a comment is a lead for where to look, never evidence.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
// Current month only: the title month and the creation time must both be the current UTC month. Older or future threads give nothing.
function currentThread(hits: unknown[]): string | null {
  const now = new Date()
  for (const h of hits as any[]) {
    const m = typeof h?.title === 'string' ? h.title.match(/^Ask HN: Who is hiring\? \(([A-Za-z]+) (\d{4})\)$/i) : null
    if (!m || !/^\d+$/.test(String(h.objectID)) || !Number.isFinite(h.created_at_i)) continue
    const c = new Date(h.created_at_i * 1000)
    if (MONTHS[now.getUTCMonth()] === m[1].toLowerCase() && now.getUTCFullYear() === Number(m[2]) && c.getUTCMonth() === now.getUTCMonth() && c.getUTCFullYear() === now.getUTCFullYear()) return String(h.objectID)
  }
  return null
}
// Board links from this month's Hacker News "Who is hiring" thread (public Algolia API, no key: one story lookup, two comment pages = 3 requests).
// Only top-level comments that name the state contribute boards. A link is where to look, never evidence: state, role and date are checked on the posting itself.
export async function hnBoards(http: SafeGet, state: string): Promise<string[]> {
  const st = await json(http, 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=3')
  const id = currentThread(Array.isArray(st?.hits) ? st.hits : [])
  if (!id) return []
  const out: string[] = []
  for (const page of [0, 1]) {
    const cm = await json(http, `https://hn.algolia.com/api/v1/search?tags=comment,story_${id}&hitsPerPage=200&page=${page}`)
    for (const h of Array.isArray(cm?.hits) ? cm.hits : []) {
      if (typeof h?.comment_text !== 'string' || String(h.parent_id) !== id) continue
      const text = unesc(h.comment_text)
      if (!locationInState(state, text.replace(/<[^>]*>/g, ' '))) continue
      out.push(...(text.match(LINK) ?? []))
    }
  }
  return [...new Set(out)]
}

export const jobBoardsAdapter: SourceAdapter = {
  id: 'jobboards',
  label: 'Greenhouse and Ashby public job boards',
  async collect({ query, keywords, feeds, pages, discovered, http }) {
    const state = stateIn(query)
    const roles = keywords.filter(k => !GENERIC.has(k) && !(state && state.toLowerCase().split(' ').includes(k)))
    if (!state || roles.length === 0) return [] // never every state, never every role
    const out: Evidence[] = []
    const roleOk = (t: string) => roles.some(k => t.toLowerCase().includes(k))
    // Boards come from the given feeds and from discovered page/hit URLs (posting links). Deduped; a lookalike host never yields a board.
    const seenBoards = new Set<string>()
    const boards: { kind: 'gh' | 'ashby'; token: string }[] = []
    for (const u of [...feeds, ...(pages ?? []), ...(discovered ?? [])]) {
      const b = board(u)
      if (!b || seenBoards.has(`${b.kind}:${b.token}`)) continue
      seenBoards.add(`${b.kind}:${b.token}`)
      boards.push(b)
    }
    for (const u of await hnBoards(http, state)) {
      const b = board(u)
      if (!b || seenBoards.has(`${b.kind}:${b.token}`)) continue
      seenBoards.add(`${b.kind}:${b.token}`)
      boards.push(b)
    }
    for (const b of boards.slice(0, MAX_BOARDS)) {
      if (b.kind === 'ashby') {
        const d = await json(http, `https://api.ashbyhq.com/posting-api/job-board/${b.token}`)
        for (const j of Array.isArray(d?.jobs) ? d.jobs : []) {
          if (j?.isListed !== true || typeof j.title !== 'string' || typeof j.jobUrl !== 'string' || !j.jobUrl.startsWith('https://')) continue
          if (!roleOk(j.title) || !locationInState(state, j.location, j.address?.postalAddress?.addressRegion)) continue
          const date = day(j.publishedAt)
          if (!fresh(date)) continue
          const quote = bodyQuote(j.descriptionPlain)
          if (!quote) continue
          out.push({ source: 'jobboards', url: j.jobUrl, title: `${j.title} (${j.location ?? state})`.slice(0, 200), quote, date })
        }
      } else {
        const d = await json(http, `https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs`)
        let n = 0
        for (const j of Array.isArray(d?.jobs) ? d.jobs : []) {
          if (n >= MAX_DETAIL) break
          if (!Number.isInteger(j?.id) || typeof j.title !== 'string' || !roleOk(j.title) || !locationInState(state, j.location?.name)) continue
          n++
          const det = await json(http, `https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs/${j.id}`)
          const date = day(det?.first_published)
          const url = typeof det?.absolute_url === 'string' ? det.absolute_url : ''
          if (!fresh(date) || !url.startsWith('https://')) continue
          const quote = bodyQuote(det.content)
          if (!quote) continue
          out.push({ source: 'jobboards', url, title: `${det.title} (${det.location?.name ?? state})`.slice(0, 200), quote, date, updated: day(det.updated_at) })
        }
      }
    }
    return out.slice(0, 30)
  },
}
