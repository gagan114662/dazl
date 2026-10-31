// Replay harness (docs/design/agent-evals.md). In test/helpers, not lib/, because it opens a raw in-memory SQLite handle (runJob
// takes one), like acceptance-harness.ts beside it; the pure contract it returns is lib/evals/result.ts.
//
// Runs the REAL scan (runJob) against a World instead of the internet. Every seam runJob takes is answered from the
// World - the model by stage, TinyFish search/fetch through fetchImpl, the verifier's own page fetch, source-adapter
// HTTP - and every answer is recorded, so a replay produces a trace too.
// Anything the World cannot answer is a WORLD MISS: recorded, answered as a failure (no results / fetch error / model
// error), never sent anywhere. Under the test net fence (test/helpers/net-fence.ts) an unstubbed path still throws.
//
// Isolation: each replay gets its own in-memory database, a throwaway master key, a stub API key and a second tenant
// seeded with canary rows, so a run that reads across tenants has something visible to leak (evaluators.ts,
// no_tenant_leak). Autopilot is replaced by a recorder: a scan replay never drafts or sends. The process clock is frozen
// at world.as_of for the duration of the replay so date windows are judged as the run saw them.
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../../lib/scan/store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { normalizeIcp } from '../../lib/scan/icp.ts'
import { claimKeyedJob, runJob } from '../../lib/scan/runner.ts'
import { resetTinyfishState } from '../../lib/search/tinyfish.ts'
import type { Provider } from '../../lib/llm/provider.ts'
import type { FetchFail, Page } from '../../lib/scan/fetch-page.ts'
import type { HttpResult, SafeGet } from '../../lib/sources/types.ts'
import { TraceRecorder, TRACE_VERSION, replayStage, type Trace } from '../../lib/evals/trace.ts'
import { validateWorld, type World, type WorldHit } from '../../lib/evals/world.ts'
import type { Case } from '../../lib/evals/case.ts'
import { CASE_TENANT, CANARY_TENANT, CANARY, type WorldMiss, type ReplayLead, type ReplayResult } from '../../lib/evals/result.ts'

const STUB_KEY = 'sk-ant-api03-EVALREPLAYEVALREPLAYEVALREPLAYEVAL'

// Freezes Date (new Date(), Date.now()) at `at`, advancing with real elapsed time, until the returned restore runs.
// Explicit dates (new Date(x)) are untouched. SQLite's own clock is not affected; nothing an evaluator reads uses it.
function freezeClock(at: number): () => void {
  const Real = Date
  const start = Real.now()
  const now = () => at + (Real.now() - start)
  class Frozen extends Real {
    constructor(...a: unknown[]) { if (a.length === 0) super(now()); else super(...(a as [string])) }
    static now() { return now() }
    static [Symbol.hasInstance](x: unknown) { return x instanceof Real } // a Date made before the freeze is still a Date
  }
  globalThis.Date = Frozen as unknown as DateConstructor
  return () => { globalThis.Date = Real }
}

function seedCanary(db: Database.Database): void {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('canary-job', ?, 'canary', 'canary', 'canary', 'running')").run(CANARY_TENANT)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score) VALUES ('canary-lead', 'canary-job', 'Canary Person', ?, ?, ?, ?, 90)").run(CANARY.company, CANARY.contact, CANARY.signal, CANARY.source_url)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'canary-job'").run()
}
const canaryIntact = (db: Database.Database): boolean => {
  const rows = db.prepare("SELECT l.company, l.contact, l.signal, l.source_url FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ?").all(CANARY_TENANT) as typeof CANARY[]
  return rows.length === 1 && rows[0].company === CANARY.company && rows[0].contact === CANARY.contact && rows[0].signal === CANARY.signal
}

// The World as the four seams runJob calls. Each records its misses.
export function worldStubs(w: World, misses: WorldMiss[]) {
  const cursor: Record<string, number> = {}
  const reply = (prompt: string) => {
    const stage = replayStage(prompt)
    const list = w.model[stage] ?? []
    const i = cursor[stage] ?? 0
    const r = list[i]
    if (!r) { misses.push({ kind: 'model', key: `${stage}#${i}` }); throw new Error(`world_miss: no model reply for stage ${stage} (call ${i + 1})`) }
    cursor[stage] = i + 1
    if (r.error) throw new Error(r.error)
    return r
  }
  const provider: Provider = {
    research: async (_k, p) => { const r = reply(p); return { text: r.text, citedUrls: r.cited_urls ?? [] } },
    complete: async (_k, p) => reply(p).text,
    completeDetailed: async (_k, p) => { const r = reply(p); return { text: r.text, model: r.model ?? null, ...(r.usage ? { usage: r.usage } : {}) } },
    configuredModel: () => 'world-replay',
  } as Provider
  const searchFor = (q: string): WorldHit[] | { status: number } => {
    const hit = w.search.by_query[q]
    if (hit) return hit
    if (w.origin === 'synthetic') {
      if (q.startsWith('site:linkedin.com/in ')) return [] // people search: no profiles unless a synthetic World lists the query
      if (w.search.default) return w.search.default
    }
    misses.push({ kind: 'search', key: q }); return []
  }
  // Any HTTP call that is not TinyFish: the World's answer for that URL, else (synthetic only) its default, else a miss
  // answered as a 404 - an absent page, never a fetched one.
  const other = (u: string): HttpResult | null => {
    if (u in w.http) return w.http[u]
    if (w.http_default) return w.http_default
    misses.push({ kind: 'http', key: u }); return { status: 404, body: '' }
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input)
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const r = searchFor(new URL(u).searchParams.get('query') ?? '')
      return Array.isArray(r) ? new Response(JSON.stringify({ results: r }), { status: 200 }) : new Response('{}', { status: r.status })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      for (const x of urls) if (!w.tinyfish_pages[x]) misses.push({ kind: 'tinyfish_page', key: x })
      return new Response(JSON.stringify({ results: urls.filter(x => w.tinyfish_pages[x]).map(x => ({ url: x, ...w.tinyfish_pages[x] })) }), { status: 200 })
    }
    const r = other(u)
    if (r === null) throw new TypeError('fetch failed (world: this call failed when recorded)')
    return new Response(r.body, { status: r.status })
  }) as typeof fetch
  const fetchPage = async (u: string): Promise<Page | FetchFail | null> => {
    const p = w.pages[u]
    if (!p) { misses.push({ kind: 'page', key: u }); return { fail: 'error' } }
    if ('threw' in p) throw new Error(p.threw)
    if ('unreachable' in p) return null
    if ('fail' in p) return { fail: p.fail }
    return { text: p.text, title: p.title, retrievedAt: Math.floor(Date.now() / 1000), ...(p.published ? { published: p.published } : {}), ...(p.structured ? { structured: p.structured } : {}) }
  }
  const sourceHttp: SafeGet = async url => other(url)
  return { provider, fetchImpl, fetchPage, sourceHttp }
}

export async function replayCase(c: Case, worldIn: World, opts: { agentLabel?: string; commit?: string | null } = {}): Promise<ReplayResult> {
  const w = validateWorld(worldIn)
  const icp = normalizeIcp(c.input.icp)
  if (!icp) throw new Error(`case ${c.id}: input.icp is not a valid profile`)
  const misses: WorldMiss[] = []
  const rec = new TraceRecorder()
  const s = worldStubs(w, misses)
  const providers = rec.providers({ anthropic: s.provider, openai: { research: async () => { misses.push({ kind: 'model', key: 'openai.research' }); return { text: '', citedUrls: [] } } } as Provider })
  let autopilotCalls = 0
  const env = { TINYFISH_API_KEY: process.env.TINYFISH_API_KEY, SITECRAWL_ENABLED: process.env.SITECRAWL_ENABLED, NEWS_SEARCH_ENABLED: process.env.NEWS_SEARCH_ENABLED, DAZL_MASTER_KEY: process.env.DAZL_MASTER_KEY, DAZL_TRACE_CAPTURE: process.env.DAZL_TRACE_CAPTURE }
  const master = randomBytes(32)
  const realFetch = globalThis.fetch
  const restoreClock = freezeClock(Date.parse(w.as_of))
  try {
    // Stub TinyFish key (the World answers, nothing is sent); sitecrawl and news are not in World v1, so they are off.
    process.env.TINYFISH_API_KEY = 'tf-world-replay'; process.env.SITECRAWL_ENABLED = '0'; process.env.NEWS_SEARCH_ENABLED = '0'; process.env.DAZL_MASTER_KEY = master.toString('base64')
    process.env.DAZL_TRACE_CAPTURE = '0' // a replay records its own trace; it is never captured into the app store
    const fetchImpl = rec.fetch(s.fetchImpl)
    globalThis.fetch = fetchImpl // code that reaches global fetch instead of deps.fetchImpl meets the World too
    resetTinyfishState()
    const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
    db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT, business_name TEXT)')
    db.prepare('INSERT INTO users VALUES (?, ?)').run(CASE_TENANT, 'Eval tenant A')
    saveKey(db, CASE_TENANT, 'anthropic', STUB_KEY, master)
    seedCanary(db)
    createQueryJob(db, CASE_TENANT, { query: c.input.request, icp: JSON.stringify(icp) })
    const job = claimKeyedJob(db, undefined, [CANARY_TENANT])
    if (!job || job.user_id !== CASE_TENANT) throw new Error(`case ${c.id}: replay could not claim its job`)
    const outcome = await runJob(db, job, {
      providers, master, fetchImpl, fetchPage: rec.pageFetcher(s.fetchPage), sourceHttp: rec.safeGet(s.sourceHttp, 'source.get'),
      score: c.input.score ?? false, ground: c.input.ground ?? false, judge: null,
      autopilot: (async () => { autopilotCalls++ }) as never,
    })
    await rec.settled() // background body reads of the recorded HTTP responses
    const jobRow = db.prepare('SELECT status, error, candidates, verified, needs_review, drop_reasons FROM scan_jobs WHERE id = ?').get(job.id) as ReplayResult['job']
    const leads = (db.prepare(`SELECT j.user_id AS tenant, l.name, l.company, l.contact, l.source_url, l.evidence_excerpt AS excerpt, l.event_date, l.review_reason, l.confidence, l.company_domain, l.date_status
      FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.id = ? ORDER BY l.company`).all(job.id)) as ReplayLead[]
    const trace: Trace = {
      v: TRACE_VERSION, kind: 'dazl.trace', id: `replay-${c.id}`, path: 'scan.discovery', synthetic: w.origin === 'synthetic', redacted: w.redacted,
      started_at: w.as_of, agent: { commit: opts.commit ?? null, ...(opts.agentLabel ? { label: opts.agentLabel } : {}) },
      input: { request: c.input.request, icp, as_of: w.as_of }, spans: rec.spans,
      output: { status: jobRow.status, leads: leads.map(l => ({ company: l.company, name: l.name, contact: l.contact, source_url: l.source_url, excerpt: l.excerpt, event_date: l.event_date, review_reason: l.review_reason, confidence: l.confidence })) },
    }
    return { outcome, job: jobRow, leads, canaryIntact: canaryIntact(db), misses, autopilotCalls, trace }
  } finally {
    restoreClock()
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
