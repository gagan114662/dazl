// Stage 2 of the research engine (LEAD_ENGINE=research): hunt. Port of ~/work/proto/ai-research/pipeline.py hunt(): every trigger's queries
// (4 each) and the people-asking queries run on the existing TinyFish search (lib/search/tinyfish.ts tfSearch, inside the scan's own caps and
// spend ledger), limited to the recency window; the top 10 results of each become Candidates, one per URL (the first query to find it keeps it).
// Other sources (E: registries, permits, ATS boards; F: engagers) hand their Candidates in as `extra`: they merge into the same queue, and a
// registry's dated record wins over a search hit for the same URL.
import type { Candidate, FunnelStage, ResearchCase, ResearchPlan } from './types.ts'
import type { SearchHit, Fail, TfDeps } from '../search/tinyfish.ts'
import { researchSearch, type SearchQueue } from './search-queue.ts'
import type { DbLike } from '../db/client.ts'

export const RESULTS_PER_QUERY = 10
export type SearchFn = (query: string, afterDate: string) => Promise<{ ok: true; hits: SearchHit[] } | { ok: false; reason: Fail | string }>

// the queries, in trigger order: each enabled trigger's first QUERIES_PER_TRIGGER, then the asking queries
export function huntQueries(plan: ResearchPlan): { triggerId: string; query: string }[] {
  const out: { triggerId: string; query: string }[] = []
  for (const t of plan.triggers) if (t.enabled !== false) for (const q of t.queries.slice(0, 4)) out.push({ triggerId: t.id, query: q })
  for (const q of plan.askingQueries.slice(0, 6)) out.push({ triggerId: 'ask', query: q })
  return out
}

export function afterDate(c: ResearchCase): string {
  return new Date(Date.parse(`${c.today}T00:00:00Z`) - c.windowDays * 86_400_000).toISOString().slice(0, 10)
}

// a URL's identity for de-duplication: no fragment, no trailing slash, no tracking parameters, lower-case host
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k)) u.searchParams.delete(k)
    return `${u.protocol}//${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch { return raw }
}

// Stops the hunt (no further query is sent): the scan's or the day's allowance is used up, the key is refused, or search is off.
const STOPS = new Set(['cap', 'auth', 'quota', 'disabled'])

export interface HuntResult { candidates: Candidate[]; funnel: FunnelStage; queries: number; failed: Record<string, number>; stopped: string | null }

// `wait` is injected so tests do not sleep. A 'rate' answer (TinyFish's per-minute limit, enforced before anything is sent, so it costs nothing)
// is retried after a pause (5 s plus up to 5 s of jitter, at most 18 times, so 1.5 to 3 minutes per query) (measured 15 Nov: 8 tries x 2.5 s with 6 workers lost 12 of 46 queries per case,
// three whole triggers); any other failure skips that query.
export async function hunt(c: ResearchCase, plan: ResearchPlan, search: SearchFn, o: { extra?: Candidate[]; concurrency?: number; rateRetries?: number; waitMs?: number; jitter?: () => number; wait?: (ms: number) => Promise<void>; deadline?: number; now?: () => number } = {}): Promise<HuntResult> {
  const t0 = Date.now()
  const qs = huntQueries(plan), after = afterDate(c)
  const wait = o.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const failed: Record<string, number> = {}
  let stopped: string | null = null
  const results: { i: number; hits: SearchHit[] }[] = []
  let next = 0
  const worker = async () => {
    while (!stopped && next < qs.length) {
      const i = next++
      if (o.deadline && now() > o.deadline) { stopped = 'deadline'; return }
      let r: Awaited<ReturnType<SearchFn>> | null = null
      for (let attempt = 0; attempt <= (o.rateRetries ?? 18); attempt++) {
        if (o.deadline && now() > o.deadline) { stopped = 'deadline'; return }
        // a throw (a spend refusal) stops every worker: no other query is sent after it
        try { r = await search(qs[i].query, after) } catch (e) { stopped = 'refused'; throw e }
        if (r.ok || r.reason !== 'rate') break
        await wait(Math.round((o.waitMs ?? 5000) * (1 + (o.jitter ?? Math.random)())))   // back off with jitter: scans sharing the key do not retry in step
      }
      if (!r) continue
      if (r.ok) { results.push({ i, hits: r.hits }); continue }
      failed[r.reason] = (failed[r.reason] ?? 0) + 1
      if (STOPS.has(r.reason)) stopped = r.reason
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 3) }, worker))
  // the query order decides which trigger keeps a URL found twice, so the result does not depend on which search answered first
  results.sort((a, b) => a.i - b.i)
  const byUrl = new Map<string, Candidate>()
  let hits = 0
  for (const { i, hits: hs } of results) {
    for (const h of hs.slice(0, RESULTS_PER_QUERY)) {
      hits++
      const k = urlKey(h.url)
      if (byUrl.has(k)) continue
      byUrl.set(k, { url: h.url, title: h.title ?? '', snippet: (h.snippet ?? '').slice(0, 400), date: h.date ? h.date.slice(0, 10) : null, triggerId: qs[i].triggerId, query: qs[i].query, via: 'tinyfish' })
    }
  }
  let extraIn = 0
  for (const x of o.extra ?? []) {
    extraIn++
    const k = urlKey(x.url), had = byUrl.get(k)
    if (!had || (x.dated === 'registry' && had.dated !== 'registry')) byUrl.set(k, x)
  }
  const candidates = [...byUrl.values()]
  const dropped: Record<string, number> = { duplicate_url: hits + extraIn - candidates.length }
  for (const [k, n] of Object.entries(failed)) dropped[`query_${k}`] = n
  return { candidates, queries: qs.length, failed, stopped,
    funnel: { stage: 'hunt', in: qs.length, out: candidates.length, dropped, seconds: Math.round((Date.now() - t0) / 1000) } }
}

// The real search: the research engine's queued TinyFish search (search-queue.ts), inside the scan's caps and spend ledger (a refusal throws
// SpendRefused, which stops the scan; it is never swallowed here).
export const tinyfishSearch = (db: DbLike, tenant: string, spent: { searches: number }, deps: TfDeps = {}, queue?: SearchQueue): SearchFn => {
  const s = researchSearch(db, tenant, spent, deps, queue)
  return (query, after) => s(query, { afterDate: after })
}
