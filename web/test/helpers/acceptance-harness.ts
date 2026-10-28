// SYNTHETIC fixture harness for the #204 NYC/London regression tests. Every external call is a stub: the "model" (profile,
// query writing, extraction), TinyFish search/fetch, and the verifier's own page fetch. Nothing here replays the real runs:
// their search responses were never stored, so what the stubs return is invented, labelled, and only exercises the code.
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../../lib/scan/store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import type { Provider } from '../../lib/llm/provider.ts'
import { inferIcp, normalizeIcp } from '../../lib/scan/icp.ts'
import { claimKeyedJob, runJob } from '../../lib/scan/runner.ts'
import { resetTinyfishState } from '../../lib/search/tinyfish.ts'
import { runReportFor } from '../../lib/scan/run-report.ts'
import { modelUsage } from '../../lib/scan/model-usage.ts'
import { sourceStats } from '../../lib/search/trace.ts'

export const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

export interface Hit { url: string; title: string; snippet: string; date: string | null }
export interface Cand { name?: string; company: string; contact?: string | null; signal: string; source_url: string; score?: number; excerpt: string; event_date: string | null }
export interface Fixture {
  request: string
  modelIcp: object                         // SYNTHETIC profile-generation reply (real normalisation and funding-stage guard run on it)
  modelQueries: string[]                   // SYNTHETIC query-writing reply
  hits: Hit[]                              // SYNTHETIC search results (returned for every query)
  tfPages: Record<string, { title: string; text: string }>   // SYNTHETIC TinyFish fetch results
  own: Record<string, { title: string; text: string; published?: string; structured?: string[] } | 'blocked' | 'js_required' | 'not_found'>   // SYNTHETIC verifier own-fetch results
  extraction: Cand[]                       // SYNTHETIC extraction reply (real parseLeads runs on it)
  onVerify?: (db: Database.Database, jobId: string) => void   // called once, while the verifier is fetching (the scan is still running)

  reviewedIcp?: object                     // a profile the USER reviewed: stored with the job exactly as POST /api/scan stores it (normalizeIcp, icp_inferred = 0); no inference is run
  deps?: Record<string, unknown>           // extra runJob deps (e.g. memory exclusions)
  runBudget?: string                       // the job's stored run_budget JSON (as POST /api/scan stores it)
  searchStatus?: number                    // the search API answers every query with this HTTP status (a source/infrastructure failure)
}
export async function runFixture(f: Fixture) {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT, business_name TEXT)'); db.prepare('INSERT INTO users VALUES (?, ?)').run('A', 'Acme')
  const icpProvider = { complete: async () => JSON.stringify(f.modelIcp) } as unknown as Provider
  const icp = f.reviewedIcp ? normalizeIcp(f.reviewedIcp)! : (await inferIcp(icpProvider, KEY, f.request)).icp
  createQueryJob(db, 'A', { query: f.request, icp: JSON.stringify(icp), ...(f.runBudget ? { runBudget: f.runBudget } : {}) })
  const job = claimKeyedJob(db)!
  const calls = { afters: [] as (string | null)[], searches: [] as string[], tfFetchBatches: [] as string[][], ownFetch: [] as string[], prompts: [] as string[] }
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const q = new URL(u).searchParams.get('query') ?? ''
      if (q.startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      calls.searches.push(q); calls.afters.push(new URL(u).searchParams.get('after_date'))
      if (f.searchStatus) return new Response('{}', { status: f.searchStatus })
      return new Response(JSON.stringify({ results: f.hits.map(h => ({ url: h.url, title: h.title, snippet: h.snippet, ...(h.date ? { date: h.date } : {}) })) }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      calls.tfFetchBatches.push(urls)
      return new Response(JSON.stringify({ results: urls.filter(x => f.tfPages[x]).map(x => ({ url: x, ...f.tfPages[x] })) }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const reply = (p: string, maxTokens?: number) => { calls.prompts.push(p); return maxTokens === 300 ? JSON.stringify(f.modelQueries) : JSON.stringify(f.extraction) }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '[]', citedUrls: [] }), // the paid fallback (when search finds nothing) also answers with no candidates
      complete: async (_k: string, p: string, _f?: typeof fetch, maxTokens?: number) => reply(p, maxTokens),
      // SYNTHETIC usage numbers (stub counts, not real tokens or charges): proves the usage path records what a provider reports.
      completeDetailed: async (_k: string, p: string, _f?: typeof fetch, maxTokens?: number) => ({ text: reply(p, maxTokens), model: 'stub-model-served', usage: { input_tokens: 1000, output_tokens: 100 } }),
      configuredModel: () => 'stub-model-requested',
    } as unknown as Provider,
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  let snapped = false
  const fetchPage = async (u: string) => {
    if (!snapped && f.onVerify) { snapped = true; f.onVerify(db, job.id) }
    calls.ownFetch.push(u)
    const o = f.own[u]
    if (!o) return { fail: 'error' as const }
    if (typeof o === 'string') return { fail: (o === 'js_required' ? 'js_required' : o === 'not_found' ? 'not_found' : 'blocked') as 'blocked' }
    return { text: o.text, title: o.title, retrievedAt: Math.floor(Date.now() / 1000), ...(o.published ? { published: o.published } : {}), ...(o.structured ? { structured: o.structured } : {}) }
  }
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; process.env.TINYFISH_API_KEY = 'tf-test'
  try {
    const r = await runJob(db, job, { providers, master, fetchPage, fetchImpl, score: false, ground: false, judge: null, ...(f.deps ?? {}) })
    const jobRow = db.prepare('SELECT status, error, candidates, verified, needs_review, dropped, drop_reasons FROM scan_jobs').get() as Record<string, unknown>
    const leads = db.prepare('SELECT company, source_url, review_reason, confidence, event_date, date_status FROM leads').all() as { company: string; source_url: string; review_reason: string | null; confidence: number | null; event_date: string | null; date_status: string | null }[]
    const report = (runReportFor(db, 'A', job.id) ?? [])[0] as Record<string, any> | undefined
    const usage = modelUsage(db, 'A', job.id); const stats = sourceStats(db, 'A', job.id)
    return { r, icp, db, job: jobRow, leads, report, calls, usage, stats, extractionPrompt: calls.prompts.find(p => p.startsWith('You turn pre-collected public items')) ?? '', queryPrompt: calls.prompts.find(p => /search queries|queries/i.test(p) && !p.startsWith('You turn')) ?? '' }
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
}
