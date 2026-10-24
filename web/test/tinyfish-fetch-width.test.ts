// Fixture tests, isolated in-memory DB and stub fetch. Not live proof, not product yield.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, tfFetchMany, pickFetchUrls, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { SearchTrace, summarizeTrace } from '../lib/search/trace.ts'

const mk = () => { const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); return db }
const NOW = 1_800_000_000
const env = { TINYFISH_API_KEY: 'k', TINYFISH_FETCHES_PER_SCAN: '25', TINYFISH_TENANT_DAILY: '500', TINYFISH_GLOBAL_FETCH_DAILY: '500', TINYFISH_PER_MINUTE: '50' }

test('pickFetchUrls: one page per site, best-ranked first, www ignored, cap honored', () => {
  const urls = ['https://acme.example/jobs/1', 'https://www.acme.example/about', 'https://beta.example/careers', 'https://acme.example/blog', 'https://gamma.example/x']
  assert.deepEqual(pickFetchUrls(urls, 25), ['https://acme.example/jobs/1', 'https://beta.example/careers', 'https://gamma.example/x'])
  assert.deepEqual(pickFetchUrls(urls, 2), ['https://acme.example/jobs/1', 'https://beta.example/careers'])
})

test('pickFetchUrls: shared job-board hosts keep distinct employers (one page per company slug), never collapse to one', () => {
  const urls = ['https://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/acme/jobs/2', 'https://boards.greenhouse.io/beta/jobs/9', 'https://jobs.lever.co/gamma/abc', 'https://jobs.lever.co/delta/def', 'https://jobs.ashbyhq.com/eps/1', 'https://apply.workable.com/zeta/j/1']
  assert.deepEqual(pickFetchUrls(urls, 25), ['https://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/beta/jobs/9', 'https://jobs.lever.co/gamma/abc', 'https://jobs.lever.co/delta/def', 'https://jobs.ashbyhq.com/eps/1', 'https://apply.workable.com/zeta/j/1'])
})

test('pickFetchUrls: aggregator hosts (many companies behind one host, no company in the path) keep every distinct page', () => {
  const urls = ['https://www.linkedin.com/jobs/view/111', 'https://www.linkedin.com/jobs/view/222', 'https://www.indeed.com/viewjob?jk=a', 'https://www.indeed.com/viewjob?jk=b', 'https://www.reddit.com/r/payroll/comments/1/x/']
  assert.deepEqual(pickFetchUrls(urls, 25), urls)
})

test('pickFetchUrls: exact duplicate urls collapse; unparseable urls are dropped', () => {
  assert.deepEqual(pickFetchUrls(['https://a.example/x', 'https://a.example/x/', 'not a url'], 25), ['https://a.example/x'])
})

const pageFor = (u: string) => ({ url: u, title: 'T', text: 'page text '.repeat(10) })
const fetcher = (log: string[][], failOn: number[] = []) => (async (_u: string, init: RequestInit) => {
  const urls = (JSON.parse(String(init.body)) as { urls: string[] }).urls; log.push(urls)
  if (failOn.includes(log.length)) return new Response('{}', { status: 500 })
  return new Response(JSON.stringify({ results: urls.map(pageFor) }), { status: 200 })
}) as unknown as typeof fetch

test('tfFetchMany: 25 urls go out as batches of 10,10,5 and every page comes back', async () => {
  const db = mk(); const log: string[][] = []; const trace = new SearchTrace()
  const urls = Array.from({ length: 25 }, (_, i) => `https://s${i}.example/p`)
  const r = await tfFetchMany(db, 't1', urls, { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher(log), trace })
  assert.deepEqual(log.map(b => b.length), [10, 10, 5]); assert.ok(r.ok && r.pages.length === 25)
  const s = summarizeTrace(trace); assert.equal(s.fetch_requested, 25); assert.equal(s.fetch_pages_with_text, 25); assert.equal(s.fetch_outcome, 'ok')
})

test('tfFetchMany: the per-scan fetch cap still binds (cap 25 never exceeded, 30 urls -> 25 requested)', async () => {
  const db = mk(); const log: string[][] = []
  const urls = Array.from({ length: 30 }, (_, i) => `https://s${i}.example/p`)
  const r = await tfFetchMany(db, 't1', urls, { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher(log) })
  assert.equal(log.flat().length, 25); assert.ok(r.ok && r.pages.length === 25)
})

test('tfFetchMany: a later batch failing keeps earlier pages and records the failure; page count is only for batches that answered', async () => {
  const db = mk(); const log: string[][] = []; const trace = new SearchTrace()
  const urls = Array.from({ length: 25 }, (_, i) => `https://s${i}.example/p`)
  const r = await tfFetchMany(db, 't1', urls, { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher(log, [2]), trace })
  assert.ok(r.ok && r.pages.length === 10, 'first batch pages kept, nothing invented for the failed batch')
  assert.equal(log.length, 2, 'stops after a provider failure instead of hammering')
  const s = summarizeTrace(trace); assert.equal(s.fetch_requested, 20); assert.equal(s.fetch_pages_with_text, 10); assert.equal(s.fetch_outcome, 'unavailable')
})

test('tfFetchMany: first batch failing returns the failure', async () => {
  const db = mk(); const r = await tfFetchMany(db, 't1', ['https://a.example/x'], { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher([], [1]) })
  assert.deepEqual(r, { ok: false, reason: 'unavailable' })
})
