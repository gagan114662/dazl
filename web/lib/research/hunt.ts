// Stage 2 of the research engine (LEAD_ENGINE=research): hunt. Port of ~/work/proto/ai-research/pipeline.py hunt(): every trigger's queries
// (4 each) and the people-asking queries run on the existing TinyFish search (lib/search/tinyfish.ts tfSearch, inside the scan's own caps and
// spend ledger), limited to the recency window; the top 10 results of each become Candidates, one per URL (the first query to find it keeps it).
// Other sources (E: registries, permits, ATS boards; F: engagers) hand their Candidates in as `extra`: they merge into the same queue, and a
// registry's dated record wins over a search hit for the same URL.
import type { Candidate, FunnelStage, ResearchCase, ResearchPlan } from './types.ts'
import type { SearchHit, Fail, TfDeps } from '../search/tinyfish.ts'
import { researchSearch, type SearchQueue } from './search-queue.ts'
import type { DbLike } from '../db/client.ts'
import type { SafeGet } from '../sources/types.ts'
import { collectRegistry, type RegistrySource } from './sources/index.ts'
import { boardCandidates } from './sources/ats-boards.ts'

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
// is retried after a pause for up to a minute and a half per query (measured 15 Nov: 8 tries x 2.5 s with 6 workers lost 12 of 46 queries per case,
// three whole triggers); any other failure skips that query.
export async function hunt(c: ResearchCase, plan: ResearchPlan, search: SearchFn, o: { extra?: Candidate[]; concurrency?: number; rateRetries?: number; waitMs?: number; wait?: (ms: number) => Promise<void>; deadline?: number; now?: () => number } = {}): Promise<HuntResult> {
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
        r = await search(qs[i].query, after)
        if (r.ok || r.reason !== 'rate') break
        await wait(o.waitMs ?? 5000)
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

// E's hook (one function, behind the same switch as engine.ts researchEngineOn): A's hunt plus the registry sources (lib/research/sources).
// Alongside the search: the sources that cover this case's place and category (city permits, city licences, SEC Form D). After it: the job
// boards the search itself found (Greenhouse / Lever / Ashby), read for their roles' own posting days. Both merge into hunt's candidates by
// hunt's own rule (a registry's dated record wins over a search hit for the same URL). Every source is a free
// public API through the guarded getter (https, public IPs, 1 MB cap); one that fails adds a note, never throws. Without LEAD_ENGINE=research
// this is exactly hunt().
export async function huntWithRegistry(c: ResearchCase, plan: ResearchPlan, search: SearchFn, http: SafeGet, o: Parameters<typeof hunt>[3] & { env?: Record<string, string | undefined>; sources?: RegistrySource[] } = {}): Promise<HuntResult & { registry: Record<string, string[]> }> {
  const { env, sources, ...ho } = o
  if ((env ?? process.env).LEAD_ENGINE !== 'research') return { ...await hunt(c, plan, search, ho), registry: {} }
  const since = afterDate(c)
  // the registry sources run alongside the search (never before it: a slow public API never delays the paid search), then merge by hunt's rule
  const [reg, h] = await Promise.all([collectRegistry(c, since, http, sources), hunt(c, plan, search, ho)])
  const boards = await boardCandidates(c, h.candidates, since, http)
  const registry = { ...reg.notes, ...(boards.notes.length ? { 'ats-boards': boards.notes } : {}) }
  // a registry's dated record wins over a search hit for the same URL (hunt's own rule); the first registry record of a URL is kept
  const byUrl = new Map(h.candidates.map(x => [urlKey(x.url), x]))
  let replaced = 0, duplicate = 0
  for (const x of [...reg.candidates, ...boards.candidates]) {
    const k = urlKey(x.url), had = byUrl.get(k)
    if (had?.dated === 'registry') { duplicate++; continue }
    if (had) replaced++
    byUrl.set(k, x)
  }
  const candidates = [...byUrl.values()]
  // every source's note reaches the scan's funnel: a source that could not be read is never shown as a market with nothing in it
  const dropped = { ...h.funnel.dropped }
  for (const [id, ns] of Object.entries(registry)) for (const n of ns) dropped[`registry_${id}_${n}`] = (dropped[`registry_${id}_${n}`] ?? 0) + 1
  if (replaced) dropped.registry_record_over_hit = replaced
  if (duplicate) dropped.duplicate_url = (dropped.duplicate_url ?? 0) + duplicate
  return { ...h, candidates, funnel: { ...h.funnel, out: candidates.length, dropped }, registry }
}

// The real search: the research engine's queued TinyFish search (search-queue.ts), inside the scan's caps and spend ledger (a refusal throws
// SpendRefused, which stops the scan; it is never swallowed here).
export const tinyfishSearch = (db: DbLike, tenant: string, spent: { searches: number }, deps: TfDeps = {}, queue?: SearchQueue): SearchFn => {
  const s = researchSearch(db, tenant, spent, deps, queue)
  return (query, after) => s(query, { afterDate: after })
}
