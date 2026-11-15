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
//     so the date is exact and needs no page read. The Candidate is NOT marked `dated: 'registry'`: that tier means "in the place and
//     category by construction" in the wiring, which a post is not;
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
// `ok` is false when every search failed: an outage, not "no posts".
export interface PostsResult { ok: boolean; candidates: Candidate[]; authors: Record<string, Author>; funnel: FunnelStage; searches: { sent: number; failed: number } }

const LI_POST = /^https:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/posts\/([A-Za-z0-9%\-]{2,100})_/i
const LI_ID = /(?:activity|ugcPost|share)[-:](\d{19})(?!\d)/
const X_POST = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{6,20})(?!\d)/i
const X_EPOCH_MS = 1288834974657

// A role names a job (founder, partner, head, director, ...); a bare company, a place, prose or the site's own name is not.
const ROLE_WORD = /\b(?:founder|co-?founder|ceo|cto|coo|cfo|cmo|cro|cpo|chief|president|owner|co-?owner|partner|principal|director|head|vp|vice president|manager|lead|consultant|sdr|bdr|ae|account executive|analyst|engineer|associate|attorney|lawyer|counsel|solicitor|dentist|doctor|officer|executive|advisor|adviser|specialist|strategist|marketer|recruiter|investor|designer|copywriter|writer|representative|developer|producer|editor|coach|architect|accountant|broker|chair(?:man|woman|person)?|board member|managing|operator|entrepreneur)\b/i
export const readsAsRole = (role: string): boolean => {
  const r = role.replace(/\s*\|\s*linkedin\s*$/i, '').trim()
  if (!r || /^(?:linkedin|x|twitter|profile|about|experience|location|greater .+|.+ (?:area|region|metropolitan area))$/i.test(r)) return false
  return ROLE_WORD.test(r)   // a job word is required: "<anything> at Acme" alone is prose ("Eat at Joe"), not a role
}
// Credentials and pronouns after a display name ("Dana Okoye, CPA, MBA", "Dana Okoye (She/Her), CPA"): only real credentials (all-caps
// acronyms, PhD, Esq, Jr ...) are stripped, so comma-separated prose stays prose.
const CREDENTIAL = /,\s*(?:[A-Z]{2,6}|Ph\.?D\.?|Esq\.?|Jr\.?|Sr\.?|M\.?D\.?|M\.?B\.?A\.?|CPA|P\.?E\.?|J\.?D\.?)\s*$/
const stripSuffixes = (n: string): string => { let prev = ''; while (prev !== n) { prev = n; n = n.replace(/\s*\([^)]{1,30}\)\s*$/, '').replace(CREDENTIAL, '').trim() } return n }
// A person's display name: 2-5 words, each capitalised, with the usual particles ("de", "van", "al"). Prose before " on LinkedIn -"
// ("Cold email tips") or a platform word is not one; an all-lowercase real name is lost (fail closed).
const NAME_PARTICLE = /^(?:de|da|del|della|di|du|van|von|der|den|la|le|bin|binti|al|el|y|e)$/
export const nameShaped = (n: string): boolean => {
  const w = n.trim().split(/\s+/)
  // "Head Of Sales" is a role; "Chris Head" is a person (a role word as a surname is fine)
  // a role word anywhere but the last word makes it a phrase ("Sales Director Secrets", "Cold Email Lead Gen"); as the last word it may be a
  // surname ("Chris Head")
  if (w.length < 2 || w.length > 5 || w.slice(0, -1).some(x => ROLE_WORD.test(x)) || /\s(?:of|at|&)\s/i.test(n)) return false
  return w.every((x, i) => /^\p{Lu}[\p{L}'’.\-]*$/u.test(x) || (i > 0 && i < w.length - 1 && NAME_PARTICLE.test(x)))
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
    const m = /^(.{2,80}?)(?:'s|’s) Post\b/.exec(t) ?? /^(.{2,80}?) on LinkedIn\s*[:\-–]/.exec(t) ?? /^(.{2,80}?) posted on the topic\b/.exec(t) ?? /\|\s*([^|#@\s][^|#@]{0,58}\s[^|#@]{1,58}?)\s*$/.exec(t)
    // a display name may carry a credential or pronouns ("Dana Okoye, CPA", "Dana Okoye (She/Her)"): the name is the part before them
    const name = m ? stripSuffixes(m[1].trim()) : null
    return { platform: 'linkedin', handle, name: name && nameShaped(name) ? name : null, profileUrl: null }
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

// Repeat calls (the goal-driven scan's loop, MISSION2 "GOAL-DRIVEN SCAN"): a caller-held state makes each call add only NEW work. Queries
// already sent are not sent again, posts already returned are not returned again, and a handle's lookups are reused.
export interface PostsState {
  queries: Set<string>
  posts: Set<string>
  handles: Map<string, { kind: Author['kind']; headline: string | null; profileUrl: string | null; name: string | null; tried: Set<string> }>
}
export const newPostsState = (): PostsState => ({ queries: new Set(), posts: new Set(), handles: new Map() })

export async function linkedinPostCandidates(rc: ResearchCase, plan: ResearchPlan, deps: { search: SearchFn; maxQueries?: number; maxResolve?: number; platforms?: ('linkedin' | 'x')[]; state?: PostsState }): Promise<PostsResult> {
  const state = deps.state ?? newPostsState()
  const t0 = Date.now(); const dropped: Record<string, number> = {}
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1 }
  const after = windowStart(rc.today, rc.windowDays)
  // a repeat call spends its query budget on queries not sent before
  const queries = postQueries(plan, deps.platforms ?? ['linkedin', 'x'], Number.MAX_SAFE_INTEGER).filter(x => !state.queries.has(x.q.toLowerCase())).slice(0, deps.maxQueries ?? 12)
  const posts = new Map<string, { hit: IndexHit; date: string; author: ReturnType<typeof authorOf> & object; triggerId: string; query: string }>()
  let seenHits = 0, sent = 0, failed = 0
  for (const { q, triggerId } of queries) {
    state.queries.add(q.toLowerCase())
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
      if (posts.has(key) || state.posts.has(key)) { drop('same post'); continue }
      posts.set(key, { hit: { ...hit, url: hit.url.split(/[?#]/)[0] }, date, author, triggerId, query: q })
    }
  }
  // Resolve each LinkedIn author once: person (with the indexed headline), company page (dropped) or unresolved (kept, marked).
  // First pass: the lookup is keyed on the handle but made on the first post that NAMES the author (an earlier unnamed post does not
  // use it up). Second pass: every post gets its handle's final answer.
  const authors: Record<string, Author> = {}
  const byHandle = state.handles
  let resolved = 0
  // strong person signals ("<Name>'s Post", "posted on the topic") are looked up first, so company pages titled "<Name> on LinkedIn:" or topic
  // titles do not spend the shared budget before real authors
  const strong = (t: string) => /(?:'s|\u2019s) Post\b|posted on the topic\b/.test(t)
  // whole handles are ordered (a handle with any person signal first); a handle's own posts keep the index order, so its earlier
  // company-titled post is still looked up before a later name on the same handle
  const hk = (p: { author: { platform: string; handle: string } }) => `${p.author.platform}:${p.author.handle.toLowerCase()}`
  const strongHandle = new Set([...posts.values()].filter(p => strong(p.hit.title ?? '')).map(hk))
  const firstPass = [...posts.values()].sort((a, b) => Number(strongHandle.has(hk(b))) - Number(strongHandle.has(hk(a))))
  for (const p of firstPass) {
    const key = `${p.author.platform}:${p.author.handle.toLowerCase()}`
    let r = byHandle.get(key)
    if (!r) { r = { kind: 'unresolved', headline: null, profileUrl: p.author.profileUrl, name: null, tried: new Set() }; byHandle.set(key, r) }
    // only an author the post title names can become a Person, so the resolve budget goes to those
    // one lookup per (handle, name), at most 3 names per handle (+1 for a strong "<Name>'s Post" signal); maxResolve caps the total.
    // Known cost (fails closed): Title Case topic titles that pass nameShaped ("Cold Email Tips") take weak slots, so a 4th plainly
    // titled real author on the same handle is not looked up; a strong-signal post still is.
    if (r.kind === 'unresolved' && p.author.platform === 'linkedin' && p.author.name && !r.tried.has(p.author.name.toLowerCase()) && r.tried.size < (strong(p.hit.title ?? '') ? 4 : 3) && resolved < (deps.maxResolve ?? 20)) {   // at most 3 names per handle, plus one for a strong signal
      r.tried.add(p.author.name.toLowerCase()); resolved++; sent++
      const hits = await safeSearch(deps.search, `${p.author.name} linkedin ${p.author.handle}`, {})
      if (hits === null) failed++
      const esc = p.author.handle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const urlOf = (h: IndexHit) => h.url.toLowerCase().split(/[?#]/)[0]
      // /in/ and /company/ are separate namespaces: a company page with this handle means the POST is the company's, even if some
      // member also owns the same /in/ vanity. A person: the /in/<handle> profile's own title must start with the name the post title
      // gives (so one person's name is never paired with another person's profile); the profile's name is never copied in.
      const nameEsc = p.author.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if ((hits ?? []).some(h => new RegExp(`linkedin\\.com/company/${esc}/?$`).test(urlOf(h)))) r.kind = 'company'
      else {
        const h = (hits ?? []).find(h => new RegExp(`linkedin\\.com/in/${esc}/?$`).test(urlOf(h)) && new RegExp(`^\\s*${nameEsc}(?:\\s*$|\\s*[,(]|\\s+[-–|])`, 'i').test(h.title ?? ''))
        if (h) { r.kind = 'person'; r.name = p.author.name; r.headline = `${h.title ?? ''} | ${h.snippet ?? ''}`.slice(0, 500); r.profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(p.author.handle)}` }
      }
    }   // an X handle is an account (a person, a firm or a newsroom): left 'unresolved' for the filter to judge
  }
  // Second pass: every post of a handle gets the handle's final resolution, whatever order the index returned the posts in.
  for (const p of posts.values()) {
    const r = byHandle.get(`${p.author.platform}:${p.author.handle.toLowerCase()}`)!
    if (r.kind === 'company') { drop('company page, not a person'); continue }
    // each post keeps the name its own title gives; a resolved person's profile is shared only with posts naming the same person
    const same = r.kind === 'person' && (!p.author.name || p.author.name.toLowerCase() === r.name?.toLowerCase())
    authors[p.hit.url] = { ...p.author, name: p.author.name ?? (same ? r.name : null), kind: same ? 'person' : 'unresolved', headline: same ? r.headline : null, profileUrl: same ? r.profileUrl : p.author.profileUrl }
  }
  for (const [k, p] of posts) if (authors[p.hit.url]) state.posts.add(k)
  const candidates: Candidate[] = [...posts.values()].filter(p => authors[p.hit.url]).map(p => ({
    url: p.hit.url, title: p.hit.title, snippet: p.hit.snippet, date: p.date, triggerId: p.triggerId, query: p.query,
    // the date above is the post ID's own (exact), but this is NOT a registry record: the post is not in the requested place or category by
    // construction, and its page is login-walled, so it must go through the filter like any search result (no `dated: 'registry'`)
    via: 'engager',
  }))
  return { ok: sent === 0 || failed < sent, candidates, authors, searches: { sent, failed }, funnel: { stage: 'hunt', in: seenHits, out: candidates.length, dropped, seconds: Math.round((Date.now() - t0) / 1000) } }
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
  const m = new RegExp(`^${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:,[^-\u2013|]{1,40})?\\s+[-\u2013|]\\s+(.{2,120})$`).exec(first.trim())   // also "Name, CPA - Partner"
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
