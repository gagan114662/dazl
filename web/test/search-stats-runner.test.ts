// Search-stats fixture test (isolated in-memory DB, stub provider, stub fetch). Not live proof, not product yield.
// Observed on a live Ohio scan: one candidate came back from the whole search. The Ohio profile names a US state in
// icp.where, but TinyFish's location option takes a country code only, so the state can only reach the search through
// the query text, and the model writes those queries freely. This pins that every issued query carries the profile's
// geography. The verifier is not touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }

function run(modelQueries: string[] | string, searchStatus = 200, extraHits: { url: string; title: string; snippet: string; date: string }[] = [], mode: true | 'first-empty-then-fail' | false = false) {
  let searchCalls = 0
  resetTinyfishState() // the per-minute window is process-wide; every scenario starts clean
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP) })
  const job = claimKeyedJob(db)!
  const searched: string[] = []
  const fetched: string[] = []
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      { const q = new URL(u).searchParams.get('query') ?? ''; if (!q.startsWith('site:linkedin.com/in ')) searched.push(q) } // discovery queries only: the post-scan people search (lib/people/people-search.ts) is pinned in its own tests
      searchCalls++
      if (mode === true) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      if (mode === 'first-empty-then-fail') return searchCalls === 1 ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: QUOTE, date: recent }, ...extraHits] }), { status: searchStatus })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) fetched.push(...(JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? [])
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${recent}. ${QUOTE}. Apply now.` }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const lead = { name: '', company: 'Harbor Freight Supply', contact: null, signal: 'Hiring a payroll specialist', source_url: 'https://jobs.example/hf', score: 80, excerpt: QUOTE, event_date: recent }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300 ? (typeof modelQueries === 'string' ? modelQueries : JSON.stringify(modelQueries)) : JSON.stringify([lead]),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Payroll specialist', retrievedAt: 1_700_000_000 })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl // the TinyFish helpers take the global fetch; restored below
  return runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null }).then(r => ({ r, searched, db, fetched })).finally(() => { globalThis.fetch = realFetch })
}

const snapRows = (db: Database.Database) => JSON.stringify({ leads: db.prepare('SELECT company, source_url FROM leads ORDER BY rowid').all(), runs: db.prepare('SELECT collector,status,candidate_count,verified_count,inserted_count FROM scan_source_runs ORDER BY collector').all(), job: db.prepare('SELECT status, candidates, verified, needs_review, dropped FROM scan_jobs').get() })
const withEnv = async <T>(stats: boolean, f: () => Promise<T>) => {
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'; if (stats) process.env.DAZL_SOURCE_STATS = '1'; process.env.DAZL_SOURCE_STATS_USERS = 'A'
  try { return await f() } finally { delete process.env.TINYFISH_API_KEY; delete process.env.DAZL_SOURCE_STATS; delete process.env.DAZL_SOURCE_STATS_USERS }
}
const MODEL_Q = ['small company hiring payroll specialist', 'complaints about payroll software small business']

test('stats on: a scan writes exactly one stats row with the queries actually sent, counts and evidence split', async () => {
  const { r, searched, db } = await withEnv(true, () => run(MODEL_Q))
  assert.equal(r, 'done')
  const rows = db.prepare('SELECT * FROM scan_source_stats').all() as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.deepEqual(JSON.parse(row.queries as string), searched, 'recorded queries equal the queries the provider received (with Ohio added)')
  assert.ok(searched.every(q => /ohio/i.test(q)))
  assert.equal(row.query_source, 'model'); assert.equal(row.collector, 'search:tinyfish')
  assert.equal(row.searches_attempted, searched.length); assert.equal(row.searches_ok, searched.length)
  assert.equal(row.hits_raw, searched.length); assert.equal(row.hits_unique_urls, 1)
  assert.equal(row.fetch_requested, 1); assert.equal(row.fetch_outcome, 'ok'); assert.equal(row.fetch_pages_with_text, 1)
  assert.equal(row.evidence_items, 1); assert.equal(row.evidence_with_page_text, 1); assert.equal(row.evidence_snippet_only, 0)
})

test('stats off (default): same scan, byte-identical outcome, no stats table exists', async () => {
  const on = await withEnv(true, () => run(MODEL_Q)); const off = await withEnv(false, () => run(MODEL_Q))
  assert.equal(snapRows(on.db), snapRows(off.db), 'recording changes nothing about the scan result')
  assert.equal(on.searched.length, off.searched.length)
  assert.equal(off.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='scan_source_stats'").get()!['n' as never], 0)
})

test('unusable model queries are recorded as fallback, not model', async () => {
  const { db } = await withEnv(true, () => run('I cannot help with that'))
  const row = db.prepare('SELECT query_source, queries FROM scan_source_stats').get() as { query_source: string; queries: string }
  assert.equal(row.query_source, 'fallback'); assert.ok(JSON.parse(row.queries).some((q: string) => /Find Ohio companies/.test(q)), 'the original request is still searched after the two direct queries')
})

test('provider search failure: recorded as an attempted failure, hit and page counts null, never zero', async () => {
  const { db } = await withEnv(true, () => run(MODEL_Q, 500))
  const row = db.prepare('SELECT * FROM scan_source_stats').get() as Record<string, unknown>
  assert.equal(row.searches_attempted, 1); assert.equal(row.searches_ok, 0)
  assert.deepEqual(JSON.parse(row.searches_failed as string), { unavailable: 1 })
  assert.equal(row.hits_raw, null); assert.equal(row.hits_unique_urls, null); assert.equal(row.fetch_requested, null); assert.equal(row.fetch_pages_with_text, null)
})

test('full funnel row: per-query hits, extracted candidates, hosts and unfetched urls come from the real run', async () => {
  const { db, searched } = await withEnv(true, () => run(MODEL_Q))
  const row = db.prepare('SELECT * FROM scan_source_stats').get() as Record<string, unknown>
  const pq = JSON.parse(row.per_query as string)
  assert.equal(pq.length, searched.length); assert.equal(pq[0].new_urls, 1); assert.equal(pq[1].new_urls, 0, 'same url from the second query is not new')
  assert.equal(row.extracted_candidates, 1); assert.equal(row.distinct_hosts, 1); assert.equal(row.urls_not_fetched, 0)
})

test('every search ok but empty: evidence_items is an actual 0 (not unknown), completeness true, no fetch and no extraction recorded', async () => {
  const { db } = await withEnv(true, () => run(MODEL_Q, 200, [], true))
  const row = db.prepare('SELECT searches_ok, hits_raw, hits_complete, evidence_items, evidence_with_page_text, evidence_snippet_only, fetch_requested, extracted_candidates FROM scan_source_stats').get() as Record<string, unknown>
  assert.deepEqual(row, { searches_ok: 4, hits_raw: 0, hits_complete: 1, evidence_items: 0, evidence_with_page_text: 0, evidence_snippet_only: 0, fetch_requested: null, extracted_candidates: null })
})

test('searches failed: evidence_items stays unknown (null), not 0', async () => {
  const { db } = await withEnv(true, () => run(MODEL_Q, 500))
  const row = db.prepare('SELECT hits_complete, evidence_items FROM scan_source_stats').get() as Record<string, unknown>
  assert.deepEqual(row, { hits_complete: null, evidence_items: null })
})

test('one query answered empty and one failed: evidence_items unknown, hits a lower bound of 0', async () => {
  const { db } = await withEnv(true, () => run(MODEL_Q, 200, [], 'first-empty-then-fail'))
  const row = db.prepare('SELECT searches_ok, hits_raw, hits_complete, evidence_items FROM scan_source_stats').get() as Record<string, unknown>
  assert.deepEqual(row, { searches_ok: 1, hits_raw: 0, hits_complete: 0, evidence_items: null })
})

const mkHit = (host: string, n: number) => ({ url: `https://${host}/p${n}`, title: 'T', snippet: 'Hiring a payroll specialist in Ohio, ' + 'x'.repeat(40), date: recent })
const EXTRA = [mkHit('a.example', 1), mkHit('a.example', 2), mkHit('a.example', 3), mkHit('b.example', 1), mkHit('b.example', 2), mkHit('boards.greenhouse.io/acme', 1), mkHit('boards.greenhouse.io/beta', 1)]

test('fetch selection with room: nothing is excluded for sharing a host (8 unique urls, cap 8, all 8 requested)', async () => {
  const { db } = await withEnv(true, () => run(MODEL_Q, 200, EXTRA))
  const row = db.prepare('SELECT hits_unique_urls, fetch_requested FROM scan_source_stats').get() as Record<string, number>
  assert.deepEqual(row, { hits_unique_urls: 8, fetch_requested: 8 })
})

test('fetch selection under a tight cap is breadth first: distinct hosts before second pages (cap 3 -> jobs.example, a.example, b.example)', async () => {
  process.env.TINYFISH_FETCHES_PER_SCAN = '3'
  try {
    const { db, fetched } = await withEnv(true, () => run(MODEL_Q, 200, EXTRA))
    assert.deepEqual(fetched, ['https://jobs.example/hf', 'https://a.example/p1', 'https://b.example/p1'])
    assert.equal((db.prepare('SELECT fetch_requested FROM scan_source_stats').get() as Record<string, number>).fetch_requested, 3)
  } finally { delete process.env.TINYFISH_FETCHES_PER_SCAN }
})

// ---- direct per-signal queries (fixture tests, not live proof) ----
// Observed: three model-written free-text queries gave 2 hits in all. A hiring request now gets deterministic ATS
// queries FIRST (they are never starved by the search cap), then the model's queries fill what is left.
test('hiring request: two deterministic ATS queries come first, each with a parenthesised group of quoted role phrases and Ohio; the model fills the remaining slots within the search cap', async () => {
  const { searched } = await withEnv(true, () => run(['m1 hiring payroll', 'm2 payroll complaints', 'm3 extra']))
  assert.equal(searched.length, 5) // 2 direct + all 3 model queries: the default cap (8) no longer cuts the model's
  assert.equal(searched[0], '(site:boards.greenhouse.io OR site:job-boards.greenhouse.io) ("payroll" OR "hr" OR "office manager") Ohio')
  assert.equal(searched[1], '(site:jobs.ashbyhq.com OR site:jobs.lever.co) ("payroll" OR "hr" OR "office manager") Ohio')
  assert.ok(/m1/.test(searched[2]) && /m2/.test(searched[3]) && /m3/.test(searched[4]) && searched.every(q => /ohio/i.test(q)))
})

test('the search cap still binds: with TINYFISH_SEARCHES_PER_SCAN=4 a hiring request sends exactly 4', async () => {
  process.env.TINYFISH_SEARCHES_PER_SCAN = '4'
  try {
    const { searched } = await withEnv(true, () => run(['m1 hiring payroll', 'm2 payroll complaints', 'm3 extra']))
    assert.equal(searched.length, 4)
  } finally { delete process.env.TINYFISH_SEARCHES_PER_SCAN }
})

test('hiring request, unusable model reply: the direct queries still run (never LLM-only)', async () => {
  const { searched, db } = await withEnv(true, () => run('I cannot help with that'))
  assert.ok(searched[0].startsWith('(site:boards.greenhouse.io OR') && searched[1].startsWith('(site:jobs.ashbyhq.com OR site:jobs.lever.co)'))
  assert.equal((db.prepare('SELECT query_source FROM scan_source_stats').get() as { query_source: string }).query_source, 'fallback')
})

test('fetch selection is per employer on a shared ATS host: two Greenhouse and two Ashby employers all survive a tight cap, ahead of second pages of other hosts', async () => {
  process.env.TINYFISH_FETCHES_PER_SCAN = '4'
  try {
    const hits = [mkHit('a.example', 1), mkHit('a.example', 2), mkHit('boards.greenhouse.io/acme', 1), mkHit('boards.greenhouse.io/beta', 1), mkHit('jobs.ashbyhq.com/gamma', 1), mkHit('jobs.ashbyhq.com/delta', 1)]
    const { fetched } = await withEnv(true, () => run(MODEL_Q, 200, hits))
    assert.deepEqual(fetched, ['https://jobs.example/hf', 'https://a.example/p1', 'https://boards.greenhouse.io/acme/p1', 'https://boards.greenhouse.io/beta/p1'])
  } finally { delete process.env.TINYFISH_FETCHES_PER_SCAN }
})
