// Person-first source for the research engine's hunt (MISSION v2, part F; port of ~/work/proto/person-first/pipeline.py).
// PUBLIC POSTS PATH: people POSTING about the trigger, found through the search index (`site:linkedin.com/posts`, `site:x.com`). No
// LinkedIn or X page is fetched and no session is used: the prototype stopped at a reCAPTCHA after two logged-out post pages, and the
// session worker (ADVANCED_WORKER_URL) is not running on either box. Session ENGAGERS (likers / commenters of a competitor's post) come
// later through that worker; this file only reads what the index already returned.
//
// What the index gives, and how each fact is proven (nothing is guessed):
//   - the AUTHOR: the post URL's own path (`linkedin.com/posts/<handle>_...`, `x.com/<handle>/status/<id>`) and the result title
//     ("<Name>'s Post", "<Name> on X: ...");
//   - the DATE: the post ID itself. LinkedIn activity / ugcPost / share IDs and X status IDs carry their creation time in the top bits,
//     so the date is exact and needs no page read; the Candidate is marked `dated: 'registry'` (dated by construction);
//   - the PERSON (not a company page) and the headline: one more index search per author for `linkedin.com/in/<handle>` (capped). A
//     handle that resolves to `linkedin.com/company/<handle>` is a company page and is dropped; an unresolved one stays, marked.
// Known error source (prototype): the snippet can come from another post or a comment shown on the same page, so it may credit a
// signal to the wrong person. The verify stage must check the quote against what it can actually open; this file never upgrades
// a snippet into a page-proven quote.
import type { Candidate, FunnelStage, Person, ResearchCase, ResearchPlan, Source } from '../types.ts'

export interface IndexHit { url: string; title: string; snippet: string; date: string | null }
// The hunt's search: one index query, `afterDate` as YYYY-MM-DD. null = the search failed or a cap stopped it (the caller's budget).
export type SearchFn = (query: string, opts: { afterDate?: string }) => Promise<IndexHit[] | null>

export interface Author {
  platform: 'linkedin' | 'x'
  handle: string
  name: string | null
  profileUrl: string
  kind: 'person' | 'company' | 'unresolved'
  headline: string | null          // the indexed profile's title + snippet, as the index shows it (not a page read)
}
export interface PostsResult { candidates: Candidate[]; authors: Record<string, Author>; funnel: FunnelStage }

const LI_POST = /^https:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/posts\/([A-Za-z0-9%\-]{2,100})_/i
const LI_ID = /(?:activity|ugcPost|share)[-:](\d{19})/
const X_POST = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{6,20})/i
const X_EPOCH_MS = 1288834974657

const isoDay = (ms: number): string | null => { if (!Number.isFinite(ms) || ms < Date.UTC(2006, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null; return new Date(ms).toISOString().slice(0, 10) }
// LinkedIn: the first 41 bits of the 64-bit activity ID are the creation time in ms. X: a snowflake (ms since the Twitter epoch).
export function postDate(url: string): string | null {
  const li = LI_ID.exec(url); if (li && LI_POST.test(url)) return isoDay(Number(BigInt(li[1]) >> BigInt(22)))
  const x = X_POST.exec(url); if (x) return isoDay(Number(BigInt(x[2]) >> BigInt(22)) + X_EPOCH_MS)
  return null
}

// The author a post URL names, and the display name its index title carries.
export function authorOf(hit: { url: string; title: string }): Pick<Author, 'platform' | 'handle' | 'name' | 'profileUrl'> | null {
  const li = LI_POST.exec(hit.url)
  if (li) {
    let handle = li[1]; try { handle = decodeURIComponent(handle) } catch { /* keep the raw slug */ }
    // "<Name>'s Post", "<Name> on LinkedIn: ...", "<Name> posted on the topic", "<post title> | <Name>" (the last can be a company page's
    // name: resolution below tells person from company)
    const t = hit.title.trim()
    const m = /^(.{2,80}?)(?:'s|’s) Post\b/.exec(t) ?? /^(.{2,80}?) on LinkedIn\b/.exec(t) ?? /^(.{2,80}?) posted on the topic\b/.exec(t) ?? /\|\s*([^|#@]{2,60}?)\s*$/.exec(t)
    return { platform: 'linkedin', handle, name: m ? m[1].trim() : null, profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(handle)}` }
  }
  const x = X_POST.exec(hit.url)
  if (x && !/^(?:i|home|search|intent|share)$/i.test(x[1])) {
    const m = /^(.{2,80}?) on (?:X|Twitter)\b/.exec(hit.title.trim())
    return { platform: 'x', handle: x[1], name: m ? m[1].replace(/\s*\(@[^)]*\)\s*$/, '').trim() : null, profileUrl: `https://x.com/${x[1]}` }
  }
  return null
}

// The index queries for this case: every trigger's queries plus the asking queries, each searched once per platform.
export function postQueries(plan: ResearchPlan, platforms: ('linkedin' | 'x')[], max: number): { q: string; triggerId: string; platform: 'linkedin' | 'x' }[] {
  const base = [...plan.triggers.filter(t => t.enabled !== false).flatMap(t => t.queries.map(q => ({ q, triggerId: t.id }))), ...plan.askingQueries.map(q => ({ q, triggerId: 'ask' }))]
  const seen = new Set<string>(); const out: { q: string; triggerId: string; platform: 'linkedin' | 'x' }[] = []
  for (const p of platforms) for (const b of base) {
    const q = `${p === 'linkedin' ? 'site:linkedin.com/posts' : 'site:x.com'} ${b.q}`.replace(/\s+/g, ' ').trim()
    if (seen.has(q.toLowerCase())) continue
    seen.add(q.toLowerCase()); out.push({ q, triggerId: b.triggerId, platform: p })
  }
  // round-robin across triggers so a cap does not spend everything on the first trigger
  const byT = new Map<string, typeof out>(); for (const o of out) byT.set(o.triggerId, [...(byT.get(o.triggerId) ?? []), o])
  const rr: typeof out = []; for (let k = 0; rr.length < out.length; k++) for (const list of byT.values()) if (list[k]) rr.push(list[k])
  return rr.slice(0, max)
}

const windowStart = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)

export async function linkedinPostCandidates(rc: ResearchCase, plan: ResearchPlan, deps: { search: SearchFn; maxQueries?: number; maxResolve?: number; platforms?: ('linkedin' | 'x')[] }): Promise<PostsResult> {
  const t0 = Date.now(); const dropped: Record<string, number> = {}
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1 }
  const after = windowStart(rc.today, rc.windowDays)
  const queries = postQueries(plan, deps.platforms ?? ['linkedin', 'x'], deps.maxQueries ?? 12)
  const posts = new Map<string, { hit: IndexHit; date: string; author: ReturnType<typeof authorOf> & object; triggerId: string; query: string }>()
  let seenHits = 0
  for (const { q, triggerId } of queries) {
    const hits = await deps.search(q, { afterDate: after })
    if (hits === null) { drop('search failed or capped'); continue }
    for (const hit of hits) {
      seenHits++
      const author = authorOf(hit)
      if (!author) { drop('not a post URL'); continue }
      const date = postDate(hit.url)
      if (!date) { drop('no date in the post ID'); continue }
      if (date < after || date > rc.today) { drop('outside the window'); continue }
      const key = hit.url.split('?')[0]
      if (posts.has(key)) { drop('same post'); continue }
      posts.set(key, { hit: { ...hit, url: key }, date, author, triggerId, query: q })
    }
  }
  // Resolve each LinkedIn author once: person (with the indexed headline), company page (dropped) or unresolved (kept, marked).
  const authors: Record<string, Author> = {}
  const byHandle = new Map<string, Author>()
  let resolved = 0
  for (const p of posts.values()) {
    const key = `${p.author.platform}:${p.author.handle.toLowerCase()}`
    let a = byHandle.get(key)
    if (!a) {
      a = { ...p.author, kind: 'unresolved', headline: null }
      if (p.author.platform === 'linkedin' && resolved < (deps.maxResolve ?? 20)) {
        resolved++
        const hits = await deps.search(`${p.author.name ?? ''} linkedin ${p.author.handle}`.trim(), {})
        const esc = p.author.handle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        for (const h of hits ?? []) {
          const u = h.url.toLowerCase().split('?')[0]
          if (new RegExp(`linkedin\\.com/in/${esc}/?$`).test(u)) { a.kind = 'person'; a.headline = `${h.title} | ${h.snippet}`.slice(0, 500); if (!a.name) a.name = h.title.split(/ [-–|] /)[0].trim() || null; break }
          if (new RegExp(`linkedin\\.com/company/${esc}/?$`).test(u)) { a.kind = 'company'; break }
        }
      }   // an X handle is an account (a person, a firm or a newsroom): left 'unresolved' for the filter to judge
      byHandle.set(key, a)
    }
    if (a.kind === 'company') { drop('company page, not a person'); continue }
    authors[p.hit.url] = a
  }
  const candidates: Candidate[] = [...posts.values()].filter(p => authors[p.hit.url]).map(p => ({
    url: p.hit.url, title: p.hit.title, snippet: p.hit.snippet, date: p.date, triggerId: p.triggerId, query: p.query,
    via: 'engager', dated: 'registry',   // the post ID is the date (see the header)
  }))
  return { candidates, authors, funnel: { stage: 'hunt', in: seenHits, out: candidates.length, dropped, seconds: Math.round((Date.now() - t0) / 1000) } }
}

// For the read / research stages: LinkedIn and X are login-walled (the fetcher never opens them), so an engager's evidence is the index
// text itself. The author's indexed profile is a Source of kind 'snippet', and the Person is taken from it only when that text names the
// person AND a role ("Dana Okoye - Founder at Okoye Growth"); the quote is verbatim from the index, never rewritten.
export function authorSource(a: Author): Source | null {
  if (a.kind !== 'person' || !a.headline) return null
  return { id: `profile:${a.platform}:${a.handle.toLowerCase()}`, url: a.profileUrl, text: a.headline, kind: 'snippet' }
}
export function authorPerson(a: Author): Person | null {
  const src = authorSource(a); if (!src || !a.name) return null
  const first = a.headline!.split(' | ')[0]
  const m = new RegExp(`^${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+[-\u2013|]\\s+(.{2,120})$`).exec(first.trim())
  if (m) return { name: a.name, title: m[1].trim(), sourceId: src.id, quote: m[0], profileUrl: a.profileUrl, from: 'research' }
  // the index's markdown profile: "# <Name>" then the headline line ("Litigation Partner at Taft Stettinius & Hollister")
  const esc = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const md = new RegExp(`(?:^|\\n|\\| )#\\s*(${esc})\\s*\\n\\s*([^\\n#*\\-][^\\n]{1,119})`).exec(a.headline!)
  if (md && !/^(?:profile|about|experience|location)\b/i.test(md[2].trim())) {
    const quote = a.headline!.slice(md.index + md[0].indexOf(md[1]), md.index + md[0].length).trim()
    return { name: a.name, title: md[2].trim(), sourceId: src.id, quote, profileUrl: a.profileUrl, from: 'research' }
  }
  return null   // the index text does not state a role next to the name: no Person (the profile URL stays on the Candidate's author)
}
