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
  profileUrl: string | null        // only once the handle is known to be this person's (resolved, or an X account): never guessed
  kind: 'person' | 'company' | 'unresolved'
  headline: string | null          // the indexed profile's title + snippet, as the index shows it (not a page read)
}
// funnel: `in` = index hits read, and in - out = the sum of `dropped` (per hit). Searches that failed or hit a cap are counted apart.
export interface PostsResult { candidates: Candidate[]; authors: Record<string, Author>; funnel: FunnelStage; searches: { sent: number; failed: number } }

const LI_POST = /^https:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/posts\/([A-Za-z0-9%\-]{2,100})_/i
const LI_ID = /(?:activity|ugcPost|share)[-:](\d{19})(?!\d)/
const X_POST = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{6,20})(?!\d)/i
const X_EPOCH_MS = 1288834974657

// A role is a job title or "<something> at/@ <company>"; a bare company, a place or the site's own name is not.
const ROLE_WORD = /\b(?:founder|co-?founder|ceo|cto|coo|cfo|cmo|cro|cpo|chief|president|owner|co-?owner|partner|principal|director|head|vp|vice president|manager|lead|consultant|sdr|bdr|ae|account executive|analyst|engineer|associate|attorney|lawyer|counsel|solicitor|dentist|doctor|officer|executive|advisor|adviser|specialist|strategist|marketer|recruiter|investor|chair(?:man|woman|person)?|board member|managing|operator|entrepreneur)\b/i
export const readsAsRole = (role: string): boolean => {
  const r = role.replace(/\s*\|\s*linkedin\s*$/i, '').trim()
  if (!r || /^(?:linkedin|x|twitter|profile|about|experience|location|greater .+|.+ (?:area|region|metropolitan area))$/i.test(r)) return false
  return ROLE_WORD.test(r) || /(?:\s@\s?|\bat\s)\S/i.test(r)
}
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
    // LinkedIn's page-title tails ("| 15 comments", "| LinkedIn") are not names
    const t = (hit.title ?? '').trim().replace(/(?:\s*\|\s*(?:\d[\d,.]*\s*(?:comments?|reactions?|likes?)|linkedin))+\s*$/i, '')
    const m = /^(.{2,80}?)(?:'s|’s) Post\b/.exec(t) ?? /^(.{2,80}?) on LinkedIn:/.exec(t) ?? /^(.{2,80}?) posted on the topic\b/.exec(t) ?? /\|\s*([^|#@]{2,60}?)\s*$/.exec(t)
    const name = m ? m[1].trim() : null
    return { platform: 'linkedin', handle, name: name && !/^(?:linkedin|\d.*)$/i.test(name) ? name : null, profileUrl: null }
  }
  const x = X_POST.exec(hit.url)
  if (x && !/^(?:i|home|search|intent|share)$/i.test(x[1])) {
    const m = /^(.{2,80}?) on (?:X|Twitter)\b/.exec((hit.title ?? '').trim())
    return { platform: 'x', handle: x[1], name: m ? m[1].replace(/\s*\(@[^)]*\)\s*$/, '').trim() : null, profileUrl: `https://x.com/${x[1]}` }
  }
  return null
}

// The index queries for this case: every trigger's queries plus the asking queries, each searched once per platform.
export function postQueries(plan: ResearchPlan, platforms: ('linkedin' | 'x')[], max: number): { q: string; triggerId: string; platform: 'linkedin' | 'x' }[] {
  const base = [...plan.triggers.filter(t => t.enabled !== false).flatMap(t => t.queries.map(q => ({ q, triggerId: t.id }))), ...plan.askingQueries.map(q => ({ q, triggerId: 'ask' }))]
  const seen = new Set<string>(); const out: { q: string; triggerId: string; platform: 'linkedin' | 'x' }[] = []
  for (const b of base) for (const p of platforms) {
    const q = `${p === 'linkedin' ? 'site:linkedin.com/posts' : 'site:x.com'} ${b.q}`.replace(/\s+/g, ' ').trim()
    if (seen.has(q.toLowerCase())) continue
    seen.add(q.toLowerCase()); out.push({ q, triggerId: b.triggerId, platform: p })
  }
  // round-robin across (trigger, platform) so a cap does not spend everything on the first trigger or the first platform
  const byT = new Map<string, typeof out>(); for (const o of out) byT.set(`${o.triggerId}:${o.platform}`, [...(byT.get(`${o.triggerId}:${o.platform}`) ?? []), o])
  const rr: typeof out = []; for (let k = 0; rr.length < out.length; k++) for (const list of byT.values()) if (list[k]) rr.push(list[k])
  return rr.slice(0, max)
}

// One post, whatever host or tracking suffix the index gave: the platform and the post's own ID.
export function postKey(url: string): string | null {
  if (LI_POST.test(url)) { const m = LI_ID.exec(url); return m ? `li:${m[1]}` : null }
  const x = X_POST.exec(url); return x ? `x:${x[2]}` : null
}
// A search that throws is a failed search, not the end of the source (what was found so far is kept).
const safeSearch = async (search: SearchFn, q: string, o: { afterDate?: string }): Promise<IndexHit[] | null> => { try { return await search(q, o) } catch { return null } }
const windowStart = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)

export async function linkedinPostCandidates(rc: ResearchCase, plan: ResearchPlan, deps: { search: SearchFn; maxQueries?: number; maxResolve?: number; platforms?: ('linkedin' | 'x')[] }): Promise<PostsResult> {
  const t0 = Date.now(); const dropped: Record<string, number> = {}
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1 }
  const after = windowStart(rc.today, rc.windowDays)
  const queries = postQueries(plan, deps.platforms ?? ['linkedin', 'x'], deps.maxQueries ?? 12)
  const posts = new Map<string, { hit: IndexHit; date: string; author: ReturnType<typeof authorOf> & object; triggerId: string; query: string }>()
  let seenHits = 0, sent = 0, failed = 0
  for (const { q, triggerId } of queries) {
    const hits = await safeSearch(deps.search, q, { afterDate: after })
    sent++
    if (hits === null) { failed++; continue }
    for (const hit of hits) {
      seenHits++
      const author = authorOf(hit)
      if (!author) { drop('not a post URL'); continue }
      const date = postDate(hit.url)
      if (!date) { drop('no date in the post ID'); continue }
      if (date < after || date > rc.today) { drop('outside the window'); continue }
      const key = postKey(hit.url) ?? hit.url.split(/[?#]/)[0]   // the same post through uk.linkedin.com, twitter.com or a #fragment is one post
      if (posts.has(key)) { drop('same post'); continue }
      posts.set(key, { hit: { ...hit, url: hit.url.split(/[?#]/)[0] }, date, author, triggerId, query: q })
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
      // only an author the post title names can become a Person, so the resolve budget goes to those
      if (p.author.platform === 'linkedin' && p.author.name && resolved < (deps.maxResolve ?? 20)) {
        resolved++
        sent++
        const hits = await safeSearch(deps.search, `${p.author.name ?? ''} linkedin ${p.author.handle}`.trim(), {})
        if (hits === null) failed++
        const esc = p.author.handle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const urlOf = (h: IndexHit) => h.url.toLowerCase().split(/[?#]/)[0]
        // /in/ and /company/ are separate namespaces: a company page with this handle means the POST is the company's, even if some
        // member also owns the same /in/ vanity. A person needs the post's own title to have named them (the profile's name is never
        // copied in, so a stranger's profile cannot pass the name check by construction).
        if ((hits ?? []).some(h => new RegExp(`linkedin\\.com/company/${esc}/?$`).test(urlOf(h)))) a.kind = 'company'
        else {
          const h = (hits ?? []).find(h => new RegExp(`linkedin\\.com/in/${esc}/?$`).test(urlOf(h)))
          if (h && a.name) { a.kind = 'person'; a.headline = `${h.title ?? ''} | ${h.snippet ?? ''}`.slice(0, 500); a.profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(p.author.handle)}` }
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
  return { candidates, authors, searches: { sent, failed }, funnel: { stage: 'hunt', in: seenHits, out: candidates.length, dropped, seconds: Math.round((Date.now() - t0) / 1000) } }
}

// For the read / research stages: LinkedIn and X are login-walled (the fetcher never opens them), so an engager's evidence is the index
// text itself. The author's indexed profile is a Source of kind 'snippet', and the Person is taken from it only when that text names the
// person AND a role ("Dana Okoye - Founder at Okoye Growth"); the quote is verbatim from the index, never rewritten.
export function authorSource(a: Author): Source | null {
  if (a.kind !== 'person' || !a.headline || !a.profileUrl) return null
  return { id: `profile:${a.platform}:${a.handle.toLowerCase()}`, url: a.profileUrl, text: a.headline, kind: 'snippet' }
}
export function authorPerson(a: Author): Person | null {
  const src = authorSource(a); if (!src || !a.name) return null
  const first = a.headline!.split(' | ')[0]
  const m = new RegExp(`^${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+[-\u2013|]\\s+(.{2,120})$`).exec(first.trim())
  if (m && readsAsRole(m[1])) return { name: a.name, title: m[1].trim(), sourceId: src.id, quote: m[0], profileUrl: a.profileUrl, from: 'research' }
  // the index's markdown profile: "# <Name>" then the headline line ("Litigation Partner at Taft Stettinius & Hollister")
  const esc = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const md = new RegExp(`(?:^|\\n|\\| )#\\s*(${esc})\\s*\\n\\s*([^\\n#*\\-][^\\n]{1,119})`).exec(a.headline!)
  if (md && readsAsRole(md[2])) {
    const quote = a.headline!.slice(md.index + md[0].indexOf(md[1]), md.index + md[0].length).trim()
    return { name: a.name, title: md[2].trim(), sourceId: src.id, quote, profileUrl: a.profileUrl, from: 'research' }
  }
  return null   // the index text does not state a role next to the name: no Person (the profile URL stays on the Candidate's author)
}
