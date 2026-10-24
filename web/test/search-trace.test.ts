import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, tfSearch, tfFetch, resetTinyfishState, queryPlan } from '../lib/search/tinyfish.ts'
import { SearchTrace, summarizeTrace, evidenceSplit, migrateSourceStats, writeSourceStats, sourceStats, sourceStatsEnabled } from '../lib/search/trace.ts'

const env = { TINYFISH_API_KEY: 'tf-secret-xyz', TINYFISH_SEARCHES_PER_SCAN: '2', TINYFISH_TENANT_DAILY: '50' }
const mk = () => { const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); return db }
const NOW = 1_800_000_000
const res = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const hit = (n: number) => ({ url: `https://s${n}.example/p`, title: `T${n}`, snippet: 'x'.repeat(50) })

test('ok searches: queries, attempted, raw hits and unique urls are recorded', async () => {
  const db = mk(); const trace = new SearchTrace(); const spent = { searches: 0 }
  await tfSearch(db, 't1', 'ohio payroll hiring one', {}, spent, { env, fetchImpl: res({ results: [hit(1), hit(2)] }), now: NOW, trace })
  await tfSearch(db, 't1', 'ohio payroll hiring two', {}, spent, { env, fetchImpl: res({ results: [hit(2), hit(3), hit(4)] }), now: NOW, trace })
  const s = summarizeTrace(trace)
  assert.deepEqual(s.queries, ['ohio payroll hiring one', 'ohio payroll hiring two'])
  assert.equal(s.searches_attempted, 2); assert.equal(s.searches_ok, 2)
  assert.equal(s.hits_raw, 5); assert.equal(s.hits_unique_urls, 4)
})

test('a provider failure is an error, never zero hits: counts stay null, code is kept', async () => {
  for (const [status, code] of [[401, 'auth'], [402, 'quota'], [429, 'rate'], [500, 'unavailable']] as const) {
    const db = mk(); const trace = new SearchTrace()
    await tfSearch(db, 't1', 'ohio payroll hiring one', {}, { searches: 0 }, { env, fetchImpl: res({}, status), now: NOW, trace })
    const s = summarizeTrace(trace)
    assert.equal(s.searches_attempted, 1); assert.equal(s.searches_ok, 0)
    assert.deepEqual(s.searches_failed, { [code]: 1 })
    assert.equal(s.hits_raw, null); assert.equal(s.hits_unique_urls, null)
  }
})

test('a local cap or local rate limit is NOT an attempt (no request was sent)', async () => {
  const db = mk(); const trace = new SearchTrace(); let calls = 0
  const f = (async () => { calls++; return new Response(JSON.stringify({ results: [hit(1)] })) }) as unknown as typeof fetch
  const spent = { searches: 2 } // per-scan cap of 2 already used
  const r = await tfSearch(db, 't1', 'ohio payroll hiring three', {}, spent, { env, fetchImpl: f, now: NOW, trace })
  assert.deepEqual(r, { ok: false, reason: 'cap' }); assert.equal(calls, 0)
  const s = summarizeTrace(trace)
  assert.equal(s.searches_attempted, 0); assert.deepEqual(s.searches_not_attempted, { cap: 1 }); assert.deepEqual(s.searches_failed, {})
})

test('a 429 from the provider and a local rate limit are told apart', async () => {
  const db = mk(); const trace = new SearchTrace()
  await tfSearch(db, 't1', 'ohio payroll hiring one', {}, { searches: 0 }, { env, fetchImpl: res({}, 429), now: NOW, trace })
  await tfSearch(db, 't1', 'ohio payroll hiring two', {}, { searches: 0 }, { env, fetchImpl: res({ results: [hit(1)] }), now: NOW + 1, trace }) // breaker is up: refused locally
  const s = summarizeTrace(trace)
  assert.deepEqual(s.searches_failed, { rate: 1 }); assert.deepEqual(s.searches_not_attempted, { rate: 1 }); assert.equal(s.searches_attempted, 1)
})

test('disabled is recorded as not attempted', async () => {
  const db = mk(); const trace = new SearchTrace()
  await tfSearch(db, 't1', 'ohio payroll hiring one', {}, { searches: 0 }, { env: {}, fetchImpl: res({}), now: NOW, trace })
  assert.deepEqual(summarizeTrace(trace).searches_not_attempted, { disabled: 1 })
})

test('fetch: requested vs pages with text; a failed fetch leaves the page count null', async () => {
  const db = mk(); const trace = new SearchTrace()
  const text = 'page text '.repeat(10)
  await tfFetch(db, 't1', ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'], { fetches: 0 }, { env, now: NOW, trace, fetchImpl: res({ results: [{ url: 'https://a.example/1', title: 'A', text }, { url: 'https://b.example/2', title: 'B', text: 'tiny' }] }) })
  let s = summarizeTrace(trace)
  assert.equal(s.fetch_requested, 3); assert.equal(s.fetch_outcome, 'ok'); assert.equal(s.fetch_pages_with_text, 1)
  const db2 = mk(); const t2 = new SearchTrace()
  await tfFetch(db2, 't1', ['https://a.example/1'], { fetches: 0 }, { env, now: NOW, trace: t2, fetchImpl: res({}, 500) })
  s = summarizeTrace(t2)
  assert.equal(s.fetch_requested, 1); assert.equal(s.fetch_outcome, 'unavailable'); assert.equal(s.fetch_pages_with_text, null)
})

test('no fetch call at all is unknown (null), not zero', () => {
  const s = summarizeTrace(new SearchTrace())
  assert.equal(s.fetch_requested, null); assert.equal(s.fetch_outcome, null); assert.equal(s.fetch_pages_with_text, null); assert.equal(s.hits_raw, null); assert.equal(s.searches_attempted, 0)
})

test('evidenceSplit: page text vs snippet only', () => {
  const items = [{ source: 'tinyfish', url: 'https://a.example/1/', title: '', quote: 'q'.repeat(30), date: null }, { source: 'tinyfish', url: 'https://b.example/2', title: '', quote: 'q'.repeat(30), date: null }]
  const pages = [{ url: 'https://a.example/1', title: '', text: 'p'.repeat(60) }]
  assert.deepEqual(evidenceSplit(items, pages), { evidence_items: 2, evidence_with_page_text: 1, evidence_snippet_only: 1 })
})

test('queryPlan tells model queries from the fallback to the raw request', () => {
  assert.deepEqual(queryPlan('["ohio payroll manager job posting", "ohio payroll software complaints"]', 'the whole request', 3), { queries: ['ohio payroll manager job posting', 'ohio payroll software complaints'], source: 'model' })
  assert.deepEqual(queryPlan('sorry I cannot', 'the whole request text', 3), { queries: ['the whole request text'], source: 'fallback' })
  assert.deepEqual(queryPlan('', 'the whole request text', 3).source, 'fallback')
})

test('persistence is off unless DAZL_SOURCE_STATS=1: no table is created, nothing is written', () => {
  assert.equal(sourceStatsEnabled({}), false); assert.equal(sourceStatsEnabled({ DAZL_SOURCE_STATS: '0' }), false); assert.equal(sourceStatsEnabled({ DAZL_SOURCE_STATS: '1' }), true)
  const db = new Database(':memory:'); db.exec('CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT)')
  const wrote = writeSourceStats(db, 'j1', 1, 'search:tinyfish', summarizeTrace(new SearchTrace()), {})
  assert.equal(wrote, false)
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='scan_source_stats'").get()!['n' as never], 0)
})

test('enabled: stats round-trip, owner-scoped read, absent table reads as null', async () => {
  const db = new Database(':memory:'); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT)')
  db.prepare('INSERT INTO scan_jobs VALUES (?,?)').run('j1', 'owner'); db.prepare('INSERT INTO scan_jobs VALUES (?,?)').run('j2', 'other')
  assert.equal(sourceStats(db, 'owner', 'j1'), null) // table absent: "not recorded"
  const e = { SOURCE: 'x', DAZL_SOURCE_STATS: '1' }
  const t = mk(); const trace = new SearchTrace()
  await tfSearch(t, 'owner', 'ohio payroll hiring one', {}, { searches: 0 }, { env, fetchImpl: res({ results: [hit(1), hit(2)] }), now: NOW, trace })
  assert.equal(writeSourceStats(db, 'j1', 1, 'search:tinyfish', { ...summarizeTrace(trace), query_source: 'model' }, e), true)
  writeSourceStats(db, 'j2', 1, 'search:tinyfish', summarizeTrace(new SearchTrace()), e)
  const rows = sourceStats(db, 'owner', 'j1')!
  assert.equal(rows.length, 1); assert.equal(rows[0].hits_raw, 2); assert.deepEqual(rows[0].queries, ['ohio payroll hiring one']); assert.equal(rows[0].query_source, 'model')
  assert.deepEqual(sourceStats(db, 'owner', 'j2'), []) // someone else's job: no rows leak
  migrateSourceStats(db) // idempotent
})

test('per-query funnel: hits and first-seen new urls per query; overlap across queries is not double counted as new', async () => {
  const db = mk(); const trace = new SearchTrace(); const spent = { searches: 0 }
  await tfSearch(db, 't1', 'ohio payroll hiring one', {}, spent, { env, fetchImpl: res({ results: [hit(1), hit(2)] }), now: NOW, trace })
  await tfSearch(db, 't1', 'ohio payroll hiring two', {}, spent, { env, fetchImpl: res({ results: [hit(2), hit(3)] }), now: NOW, trace })
  const s = summarizeTrace(trace)
  assert.deepEqual(s.per_query, [
    { query: 'ohio payroll hiring one', outcome: 'ok', hits: 2, new_urls: 2 },
    { query: 'ohio payroll hiring two', outcome: 'ok', hits: 2, new_urls: 1 },
  ])
})

test('per-query funnel: a failed query has hits null and new_urls null, a refused one says not attempted', async () => {
  const db = mk(); const trace = new SearchTrace(); const spent = { searches: 0 }
  await tfSearch(db, 't1', 'ohio payroll hiring one', {}, spent, { env, fetchImpl: res({}, 500), now: NOW, trace })
  await tfSearch(db, 't1', 'ohio payroll hiring two', {}, { searches: 2 }, { env, fetchImpl: res({}), now: NOW, trace })
  assert.deepEqual(summarizeTrace(trace).per_query, [
    { query: 'ohio payroll hiring one', outcome: 'unavailable', hits: null, new_urls: null },
    { query: 'ohio payroll hiring two', outcome: 'not_attempted:cap', hits: null, new_urls: null },
  ])
})

test('funnel width: distinct hosts of unique urls, and urls left unfetched by the fetch cap', async () => {
  const db = mk(); const trace = new SearchTrace()
  const many = [1, 2, 3, 4, 5].map(n => ({ url: `https://${n <= 2 ? 'same.example' : `h${n}.example`}/p${n}`, title: 'T', snippet: 'x'.repeat(50) }))
  await tfSearch(db, 't1', 'ohio payroll hiring one', {}, { searches: 0 }, { env, fetchImpl: res({ results: many }), now: NOW, trace })
  trace.fetch({ requested: 3, attempted: true, outcome: 'ok', pages: 3 })
  const s = summarizeTrace(trace)
  assert.equal(s.hits_unique_urls, 5); assert.equal(s.distinct_hosts, 4)
  assert.equal(s.urls_not_fetched, 2, '5 unique urls, 3 requested from the provider')
})
