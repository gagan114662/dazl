import type { Evidence, SourceAdapter, SafeGet } from './types.ts'

// Public job-board JSON (Greenhouse, Ashby). Evidence only: a posting says a company is hiring a role in a state.
// It is not proof of a need; the normal verifier still checks every lead against the cited page.
// Dates: Greenhouse `first_published` and Ashby `publishedAt` only. `updated_at` is never used as the posting date.
// Only the two documented API hosts are ever requested, and only for board tokens that pass a strict pattern.
const STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' }
const WINDOW_DAYS = 90
const MAX_DETAIL = 5
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const GENERIC = new Set(['hiring', 'roles', 'role', 'jobs', 'job', 'open', 'openings', 'positions', 'position', 'team', 'remote'])

export function stateIn(query: string): string | null {
  const q = query.toLowerCase()
  for (const [, name] of Object.entries(STATES)) if (new RegExp(`\\b${name.toLowerCase()}\\b`).test(q)) return name
  return null
}
export function locationInState(state: string, ...locs: (string | undefined)[]): boolean {
  const abbr = Object.keys(STATES).find(k => STATES[k] === state)!
  return locs.some(l => !!l && (new RegExp(`\\b${state}\\b`, 'i').test(l) || new RegExp(`,\\s*${abbr}\\b`).test(l)))
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
  if (u.protocol !== 'https:' || u.search || u.hash) return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 1 || !TOKEN.test(parts[0]) || /%/.test(u.pathname)) return null
  if (u.hostname === 'boards.greenhouse.io' || u.hostname === 'job-boards.greenhouse.io') return { kind: 'gh', token: parts[0] }
  if (u.hostname === 'jobs.ashbyhq.com') return { kind: 'ashby', token: parts[0] }
  return null
}

export const jobBoardsAdapter: SourceAdapter = {
  id: 'jobboards',
  label: 'Greenhouse and Ashby public job boards',
  async collect({ query, keywords, feeds, http }) {
    const state = stateIn(query)
    const roles = keywords.filter(k => !GENERIC.has(k) && !(state && state.toLowerCase().split(' ').includes(k)))
    if (!state || roles.length === 0) return [] // never every state, never every role
    const out: Evidence[] = []
    const roleOk = (t: string) => roles.some(k => t.toLowerCase().includes(k))
    for (const feed of feeds.slice(0, 10)) {
      const b = board(feed)
      if (!b) continue
      if (b.kind === 'ashby') {
        const d = await json(http, `https://api.ashbyhq.com/posting-api/job-board/${b.token}`)
        for (const j of Array.isArray(d?.jobs) ? d.jobs : []) {
          if (j?.isListed !== true || typeof j.title !== 'string' || typeof j.jobUrl !== 'string' || !j.jobUrl.startsWith('https://')) continue
          if (!roleOk(j.title) || !locationInState(state, j.location, j.address?.postalAddress?.addressRegion)) continue
          const date = day(j.publishedAt)
          if (!fresh(date)) continue
          out.push({ source: 'jobboards', url: j.jobUrl, title: `${j.title} (${j.location ?? state})`.slice(0, 200), quote: `${j.title} ${j.location ?? ''}`.trim().slice(0, 300), date })
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
          out.push({ source: 'jobboards', url, title: `${det.title} (${det.location?.name ?? state})`.slice(0, 200), quote: `${det.title} ${det.location?.name ?? ''}`.trim().slice(0, 300), date, updated: day(det.updated_at) })
        }
      }
    }
    return out.slice(0, 30)
  },
}
