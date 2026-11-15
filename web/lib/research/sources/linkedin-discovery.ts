// Part F's hunt adapter (MISSION v2; Hermes decision 15 Nov 06:13, #1099: "(a) discovery only"): public LinkedIn / X posts DISCOVER leads, and
// the lead's evidence is an OPENABLE page. No LinkedIn or X page is fetched, no session is used, no model is called, nothing is paid.
//
// Why not hand the posts to hunt as Candidates: the engine proves an event only by opening the page and finding the quote on it, and the filter
// (filter.ts BLOCKED) drops linkedin.com / x.com as `unopenable_host` before anything is read. A raw post can never become a lead.
// What a post does give is what it SAYS: a company, a launch, an opening, a claim. So each post becomes ONE ordinary web search for that text,
// and the openable results (the company's own site, its press page, a news article) enter the normal filter / read / verify path like any other
// search result. Their `via` is 'engager' and their trigger is the post's, so the goal loop can see which triggers and sources produce verified
// leads and send effort there.
//
// Budget: every search goes through the hunt's own `search` (the scan's search budget and spend ledger), so the posts' and the follow-up searches
// are counted with the rest. `maxPostQueries` + `maxDerived` bound it (6 + 10 by default). A spend refusal (a throw) is not swallowed: after one,
// nothing more is sent and the refusal is rethrown to the hunt, which stops the scan as it does for its own queries.
import type { Candidate, ResearchCase, ResearchPlan } from '../types.ts'
import { linkedinPostCandidates, newPostsState, postQueries, type IndexHit, type PostsState } from './linkedin-engagers.ts'

// Structurally the hunt's SearchFn (hunt.ts); declared here so this file does not import hunt.ts (which imports this one).
export type SourceSearch = (query: string, afterDate: string) => Promise<{ ok: true; hits: { url: string; title?: string; snippet?: string; date?: string | null }[] } | { ok: false; reason: string }>
export interface SourceOpts { rateRetries?: number; waitMs?: number; jitter?: () => number; wait?: (ms: number) => Promise<void>; deadline?: number; now?: () => number }
export interface HuntSourceStat { id: string; in: number; out: number; searches: number; failed: number; dropped: Record<string, number> }
export interface HuntSource { id: string; newState?(): unknown; run(c: ResearchCase, plan: ResearchPlan, search: SourceSearch, o?: SourceOpts, state?: unknown): Promise<{ candidates: Candidate[]; stat: HuntSourceStat; stopped?: string }> }

// Same answer to TinyFish's per-minute limit as the hunt's workers: a 'rate' answer cost nothing and is retried after a pause with jitter.
// A throw (a spend refusal) is remembered, stops every later call, and is rethrown by `rethrow()` once the source is done. A STOP answer
// (cap, auth, quota, disabled: the scan's or the day's allowance is used up, the key is refused, search is off) stops every later call too, without
// sending it, and is reported through `stopReason()` so the hunt stops as it does for its own queries.
const STOPS = new Set(['cap', 'auth', 'quota', 'disabled'])
export function guardedSearch(search: SourceSearch, o: SourceOpts = {}): { call: SourceSearch; rethrow: () => void; sent: () => number; failed: () => number; stopReason: () => string | null } {
  let fatal: unknown = null, stop: string | null = null, sent = 0, failed = 0
  const now = o.now ?? Date.now
  const wait = o.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const call: SourceSearch = async (q, after) => {
    if (fatal) return { ok: false, reason: 'refused' }
    if (stop) return { ok: false, reason: stop }
    for (let attempt = 0; attempt <= (o.rateRetries ?? 18); attempt++) {
      if (o.deadline && now() > o.deadline) { failed++; stop = 'deadline'; return { ok: false, reason: 'deadline' } }
      sent++
      let r: Awaited<ReturnType<SourceSearch>>
      try { r = await search(q, after) } catch (e) { fatal = e; failed++; return { ok: false, reason: 'refused' } }
      if (r.ok || r.reason !== 'rate') { if (!r.ok) { failed++; if (STOPS.has(r.reason)) stop = r.reason }; return r }
      sent--   // a rate answer was not sent
      await wait(Math.round((o.waitMs ?? 5000) * (1 + (o.jitter ?? Math.random)())))
    }
    failed++
    return { ok: false, reason: 'rate' }
  }
  return { call, rethrow: () => { if (fatal) throw fatal }, sent: () => sent, failed: () => failed, stopReason: () => stop }
}

// Hosts whose pages the fetcher cannot open (the filter's BLOCKED list, filter.ts): a result from one cannot be read, so it is not a lead.
const UNOPENABLE = ['linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'reddit.com', 'indeed.com', 'glassdoor.com']
const openable = (url: string): boolean => { try { const u = new URL(url); const h = u.hostname.toLowerCase(); return /^https?:$/.test(u.protocol) && !!h && !UNOPENABLE.some(w => h === w || h.endsWith('.' + w)) } catch { return false } }

// The words of a post that make a good search: what it says, without platform noise. null when there is too little to search for.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'we', 'i', 'you', 'it', 'this', 'that', 'with', 'at', 'by', 'as', 'be', 'our', 'my', 'your', 'so', 'if', 'but'])
export function derivedQuery(post: { title: string; snippet: string }, where: string): string | null {
  const generic = /(?:'s|’s) Post\b|posted on the topic\b/i.test(post.title) || post.title.trim().length < 12
  const raw = generic ? post.snippet : `${post.title.replace(/\s*[|\-–]\s*(?:LinkedIn|[A-Z][\w.' ]{1,30})\s*$/, '')} ${post.snippet}`
  const words = raw
    .replace(/https?:\/\/\S+/g, ' ').replace(/[#@]\S+/g, ' ').replace(/\.{2,}|…/g, ' ')
    .replace(/[^\p{L}\p{N}&'’\- ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.filter(w => !STOP.has(w.toLowerCase())).length < 4) return null
  const q = words.slice(0, 12).join(' ')
  const city = where.split(',')[0].trim()
  return city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q} ${city}` : q
}

// `pending`: posts found by an earlier call whose derived search was not made (the per-call cap) or failed: the next call makes them first.
// A search that was SENT and failed may have been billed, so it is retried at most once more (MAX_TRIES in all), and a failed post query only after
// the queries not yet sent (`retryQueries`: query -> failed tries). `derivedFails`: the same count per follow-up search.
export const MAX_TRIES = 2
export interface DiscoveryState extends PostsState { derived: Set<string>; pending: Candidate[]; retryQueries: Map<string, number>; derivedFails: Map<string, number> }
export const newDiscoveryState = (): DiscoveryState => ({ ...newPostsState(), derived: new Set(), pending: [], retryQueries: new Map(), derivedFails: new Map() })
// Never sent: a stop, a refusal, the deadline, or a rate answer that cost nothing. Such a query is simply unsent.
// ('quota', TinyFish's 402, may have been billed, so it counts as a try.)
const neverSent = (reason: string) => ['refused', 'deadline', 'rate', 'cap', 'auth', 'disabled'].includes(reason)

export const linkedinPostsSource = (cfg: { maxPostQueries?: number; maxDerived?: number } = {}): HuntSource => ({
  id: 'linkedin-posts',
  newState: newDiscoveryState,
  async run(c, plan, search, o = {}, st) {
    const state = (st as DiscoveryState | undefined) ?? newDiscoveryState()
    const g = guardedSearch(search, o)
    const after = afterOf(c)
    const dropped: Record<string, number> = {}
    const drop = (why: string, n = 1) => { dropped[why] = (dropped[why] ?? 0) + n }
    // failed post queries are tried again only in the slots the not-yet-sent queries leave (so a persistently failing query cannot starve the rest)
    const maxPostQueries = cfg.maxPostQueries ?? 6
    let slots = maxPostQueries - postQueries(plan, ['linkedin', 'x'], Number.MAX_SAFE_INTEGER).filter(x => !state.queries.has(x.q.toLowerCase())).length
    for (const [lq, tries] of state.retryQueries) { if (slots <= 0) break; if (tries >= MAX_TRIES) continue; state.queries.delete(lq); slots-- }
    // 1. the posts (the index's own date for each is the post ID's); no author lookups: for discovery a company's post is as good as a person's
    const posts = await linkedinPostCandidates(c, plan, { search: async (q, opts) => { const r = await g.call(q, opts.afterDate ?? after); const lq = q.toLowerCase(); if (r.ok) state.retryQueries.delete(lq); else if (neverSent(r.reason)) state.queries.delete(lq); else state.retryQueries.set(lq, (state.retryQueries.get(lq) ?? 0) + 1); return r.ok ? r.hits.map(h => ({ url: h.url, title: h.title ?? '', snippet: h.snippet ?? '', date: h.date ?? null } as IndexHit)) : null }, maxQueries: maxPostQueries, maxResolve: 0, state })
    // 2. one web search per post for what it says: the openable results are the candidates
    const out = new Map<string, Candidate>()
    const fresh = [...posts.candidates].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    const ordered = [...state.pending, ...fresh]; state.pending = []
    const retry: Candidate[] = []   // posts whose search failed: they wait AFTER the posts not yet searched, so a persistent failure cannot starve them
    let derivedSent = 0
    const triedNow = new Set<string>()
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i]
      // the cap, or a stop from the provider: this post and the rest wait for the next call (nothing more is sent now)
      if (derivedSent >= (cfg.maxDerived ?? 10) || g.stopReason()) { state.pending.push(...ordered.slice(i)); drop(g.stopReason() ? `stopped: ${g.stopReason()}` : 'deferred: derived search cap', ordered.length - i); break }
      const q = derivedQuery(p, c.where)
      if (!q) { drop('too little text to search'); continue }
      const lq = q.toLowerCase()
      if (state.derived.has(lq)) { drop('same search'); continue }
      if ((state.derivedFails.get(lq) ?? 0) >= MAX_TRIES) { drop('gave up: the search failed twice'); continue }
      if (triedNow.has(lq)) { drop('same search failed this call'); retry.push(p); continue }   // not sent again in one call
      triedNow.add(lq)
      const r = await g.call(q, after); derivedSent++
      if (!r.ok) { drop(`search ${r.reason}`); if (!neverSent(r.reason)) state.derivedFails.set(lq, (state.derivedFails.get(lq) ?? 0) + 1); retry.push(p); continue }   // not remembered as done: the next call retries it (at most twice in all), after the unsearched posts
      state.derived.add(lq)
      for (const h of r.hits.slice(0, 10)) {
        if (!openable(h.url)) { drop('unopenable host'); continue }
        if (out.has(h.url)) { drop('same url'); continue }
        out.set(h.url, { url: h.url, title: h.title ?? '', snippet: (h.snippet ?? '').slice(0, 400), date: h.date ? h.date.slice(0, 10) : null, triggerId: p.triggerId, query: q, via: 'engager' })
      }
    }
    state.pending.push(...retry)
    g.rethrow()   // a spend refusal stops the scan, as for the hunt's own queries
    const candidates = [...out.values()]
    return { candidates, stat: { id: 'linkedin-posts', in: posts.candidates.length, out: candidates.length, searches: g.sent(), failed: g.failed(), dropped }, ...(g.stopReason() ? { stopped: g.stopReason()! } : {}) }
  },
})
const afterOf = (c: ResearchCase): string => new Date(Date.parse(`${c.today}T00:00:00Z`) - c.windowDays * 86_400_000).toISOString().slice(0, 10)

// The sources the hunt runs when its caller names none: RESEARCH_SOURCES="linkedin-posts" (comma list). None by default.
export const huntSourcesFromEnv = (env: Record<string, string | undefined> = process.env): HuntSource[] =>
  (env.RESEARCH_SOURCES ?? '').split(',').map(s => s.trim()).filter(Boolean).flatMap(id => (id === 'linkedin-posts' ? [linkedinPostsSource()] : []))

