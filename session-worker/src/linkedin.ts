// LinkedIn person-level signals (owner decision 2026-10-26: LinkedIn is allowed for lead discovery through the tenant's
// own session, rate-limited). Two modes, chosen by a query prefix so the worker protocol is unchanged:
//   people:<keywords>       people search (the ICP's buyer roles, industry, place) -> profiles
//   engagers:<competitor>   recent posts that mention the competitor -> the people who commented on or reacted to them
// Each person becomes one WorkerItem: url = public profile URL, title = name, quote = headline + what they did,
// date = the post's date when known. login_walled stays true: dazl cannot re-verify a LinkedIn page without a session.
//
// Voyager payload shapes shift without notice, so the parsers do not depend on one layout: they walk the JSON for
// profile-shaped objects (publicIdentifier + firstName/lastName, or a search entity whose link is a /in/ profile).
// NOT verified against live LinkedIn responses yet; fixtures follow the shapes LinkedIn has used for these endpoints.
import { epochDay, getJson, item, type WorkerItem } from './util.ts'

export interface LiPerson { publicId: string; name: string; headline: string }
const PUBLIC_ID = /^[A-Za-z0-9\-_%]{3,100}$/

// Any object that looks like a member: miniProfile (firstName, lastName, occupation, publicIdentifier) or a dash profile
// (headline), or a search entityResult ({ title: { text }, primarySubtitle: { text }, navigationUrl: .../in/<id> }).
export function findPeople(raw: unknown, max = 25): LiPerson[] {
  const out = new Map<string, LiPerson>()
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 40 || out.size >= max) return
    if (Array.isArray(v)) { for (const e of v) walk(e, depth + 1); return }
    const o = v as Record<string, unknown>
    if (typeof o.publicIdentifier === 'string' && PUBLIC_ID.test(o.publicIdentifier) && typeof o.firstName === 'string' && typeof o.lastName === 'string') {
      const headline = typeof o.occupation === 'string' ? o.occupation : typeof o.headline === 'string' ? o.headline : ''
      if (!out.has(o.publicIdentifier)) out.set(o.publicIdentifier, { publicId: o.publicIdentifier, name: `${o.firstName} ${o.lastName}`.trim(), headline })
    }
    const nav = typeof o.navigationUrl === 'string' ? o.navigationUrl.match(/linkedin\.com\/in\/([A-Za-z0-9\-_%]{3,100})/) : null
    const title = (o.title as { text?: unknown } | undefined)?.text
    if (nav && typeof title === 'string' && title.trim().length >= 3 && !/linkedin member/i.test(title)) {
      const headline = (o.primarySubtitle as { text?: unknown } | undefined)?.text
      if (!out.has(nav[1])) out.set(nav[1], { publicId: nav[1], name: title.trim(), headline: typeof headline === 'string' ? headline : '' })
    }
    for (const e of Object.values(o)) walk(e, depth + 1)
  }
  walk(raw, 0)
  return [...out.values()]
}

export const profileUrl = (publicId: string) => `https://www.linkedin.com/in/${publicId}/`
export function personItems(people: LiPerson[], action: string, date: string | null): WorkerItem[] {
  const out: WorkerItem[] = []
  for (const p of people) {
    const it = item(profileUrl(p.publicId), p.name, `${p.name}${p.headline ? `, ${p.headline}` : ''}. ${action}`, date)
    if (it) out.push(it)
  }
  return out
}

// Activity ids (posts) with their dates, from a content search payload.
export function findPosts(raw: unknown, max = 3): { id: string; date: string | null }[] {
  const out = new Map<string, string | null>()
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 40 || out.size >= max) return
    if (Array.isArray(v)) { for (const e of v) walk(e, depth + 1); return }
    const o = v as Record<string, unknown>
    for (const k of ['trackingUrn', 'urn', 'entityUrn', 'updateUrn']) {
      const m = typeof o[k] === 'string' ? (o[k] as string).match(/activity:(\d{10,25})/) : null
      if (m && !out.has(m[1])) { out.set(m[1], epochDay(o.createdAt ?? o.publishedAt ?? (o.actor as Record<string, unknown> | undefined)?.createdAt)); break }
    }
    for (const e of Object.values(o)) walk(e, depth + 1)
  }
  walk(raw, 0)
  return [...out.entries()].map(([id, date]) => ({ id, date }))
}

type Get = (url: string) => Promise<unknown | null>
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function linkedinPeople(keywords: string, get: Get): Promise<WorkerItem[]> {
  const q = `(keywords:${encodeURIComponent(keywords.replace(/[(),:]/g, ' ').trim())},flagshipSearchIntent:SEARCH_SRP,queryParameters:(resultType:List(PEOPLE)))`
  const json = await get(`https://www.linkedin.com/voyager/api/search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-174&origin=GLOBAL_SEARCH_HEADER&q=all&query=${q}&start=0&count=10`)
  return json ? personItems(findPeople(json, 10), `Matches the search "${keywords.slice(0, 80)}" on LinkedIn.`, null) : []
}

// Competitor engagement: up to 3 recent posts mentioning the competitor; commenters and reactors of each.
export async function linkedinEngagers(competitor: string, get: Get, gapMs = 1500): Promise<WorkerItem[]> {
  const search = await get(`https://www.linkedin.com/voyager/api/search/blended?keywords=${encodeURIComponent(competitor)}&count=10&filters=List(resultType-%3ECONTENT)`)
  if (!search) return []
  const out: WorkerItem[] = []
  const seen = new Set<string>()
  for (const post of findPosts(search, 3)) {
    const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${post.id}/`
    for (const [kind, url] of [
      ['commented on', `https://www.linkedin.com/voyager/api/feed/comments?count=20&q=comments&sortOrder=RELEVANCE&updateId=activity:${post.id}`],
      ['reacted to', `https://www.linkedin.com/voyager/api/feed/reactions?count=20&q=reactionType&threadUrn=urn:li:activity:${post.id}`],
    ] as const) {
      await pause(gapMs)
      const json = await get(url)
      if (!json) continue
      for (const it of personItems(findPeople(json, 20), `${kind[0].toUpperCase()}${kind.slice(1)} a LinkedIn post about ${competitor.slice(0, 60)}: ${postUrl}`, post.date)) {
        if (seen.has(it.url)) continue
        seen.add(it.url); out.push(it)
        if (out.length >= 20) return out
      }
    }
  }
  return out
}

// Session headers for voyager calls. Returns null when the cookie lacks li_at or JSESSIONID.
export function voyagerGet(session: string): Get | null {
  const liAt = session.match(/li_at=([^;]+)/)?.[1]
  const jsession = session.match(/JSESSIONID="?([^";]+)"?/)?.[1]
  if (!liAt || !jsession) return null
  return url => getJson(url, { cookie: `li_at=${liAt}; JSESSIONID="${jsession}"`, headers: { 'csrf-token': jsession, 'x-restli-protocol-version': '2.0.0', referer: 'https://www.linkedin.com/feed/' } })
}
