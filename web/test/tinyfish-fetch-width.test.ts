// Fixture tests, isolated in-memory DB and stub fetch. Not live proof, not product yield.
// Design rule (no host taxonomy): selection only REORDERS and removes exact duplicates. It never excludes a distinct
// page because of its host, so employers behind a shared host (any ATS, any aggregator, any platform subdomain site)
// are not dropped. Breadth first: the first-ranked page of each distinct host goes ahead of second pages of any host.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, tfFetchMany, pickFetchUrls, canonicalUrl, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { SearchTrace, summarizeTrace } from '../lib/search/trace.ts'

const mk = () => { const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); return db }
const NOW = 1_800_000_000
const env = { TINYFISH_API_KEY: 'k', TINYFISH_FETCHES_PER_SCAN: '25', TINYFISH_TENANT_DAILY: '500', TINYFISH_GLOBAL_FETCH_DAILY: '500', TINYFISH_PER_MINUTE: '50' }

test('canonicalUrl: tracking parameters, fragments, www and trailing slash do not make a different page; content parameters do', () => {
  assert.equal(canonicalUrl('https://www.indeed.com/viewjob?jk=abc&utm_source=x&utm_medium=y&fbclid=1#top'), 'https://indeed.com/viewjob?jk=abc')
  assert.equal(canonicalUrl('https://a.example/p/?gclid=1'), 'https://a.example/p')
  assert.notEqual(canonicalUrl('https://www.indeed.com/viewjob?jk=a'), canonicalUrl('https://www.indeed.com/viewjob?jk=b'))
  assert.equal(canonicalUrl('https://a.example/p?b=2&a=1'), canonicalUrl('https://a.example/p?a=1&b=2'), 'parameter order is not a different page')
  assert.equal(canonicalUrl('not a url'), null)
})

test('pickFetchUrls: tracking-parameter duplicates of one page are fetched once', () => {
  const urls = ['https://www.indeed.com/viewjob?jk=a&utm_source=x', 'https://www.indeed.com/viewjob?jk=a&utm_source=y', 'https://www.indeed.com/viewjob?jk=a']
  assert.deepEqual(pickFetchUrls(urls, 25), ['https://www.indeed.com/viewjob?jk=a&utm_source=x'])
})

test('pickFetchUrls: nothing is excluded for sharing a host while there is room (ATS, aggregator, any host)', () => {
  const urls = ['https://acme.wd1.myworkdayjobs.com/en/jobs/1', 'https://beta.wd1.myworkdayjobs.com/en/jobs/2', 'https://careers.icims.com/jobs/1/a', 'https://careers.icims.com/jobs/2/b', 'https://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/beta/jobs/9', 'https://x.taleo.net/careersection/a', 'https://x.taleo.net/careersection/b']
  const out = pickFetchUrls(urls, 25)
  assert.equal(out.length, urls.length); assert.deepEqual([...out].sort(), [...urls].sort())
})

test('pickFetchUrls: breadth first. When the cap bites, first pages of distinct hosts come before second pages of any host', () => {
  const urls = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://b.example/1', 'https://b.example/2', 'https://c.example/1']
  assert.deepEqual(pickFetchUrls(urls, 3), ['https://a.example/1', 'https://b.example/1', 'https://c.example/1'])
  assert.deepEqual(pickFetchUrls(urls, 5), ['https://a.example/1', 'https://b.example/1', 'https://c.example/1', 'https://a.example/2', 'https://b.example/2'])
})

test('pickFetchUrls: a shared host that outranks everyone does not crowd out other hosts when the cap bites', () => {
  const urls = ['https://boards.greenhouse.io/a/1', 'https://boards.greenhouse.io/b/1', 'https://boards.greenhouse.io/c/1', 'https://solo.example/1', 'https://other.example/1']
  assert.deepEqual(pickFetchUrls(urls, 3), ['https://boards.greenhouse.io/a/1', 'https://solo.example/1', 'https://other.example/1'])
  // The price of not having a host list is stated, not hidden: under a tight cap a shared host can lose pages of distinct employers.
})

test('pickFetchUrls: exact order within a host and host order by first rank are preserved; unparseable urls dropped; max 0 gives none', () => {
  assert.deepEqual(pickFetchUrls(['https://b.example/2', 'https://a.example/1', 'https://b.example/1', 'junk'], 25), ['https://b.example/2', 'https://a.example/1', 'https://b.example/1'])
  assert.deepEqual(pickFetchUrls(['https://a.example/1'], 0), [])
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
  const s = summarizeTrace(trace); assert.equal(s.fetch_requested, 25); assert.equal(s.fetch_pages_with_text, 25); assert.equal(s.fetch_outcome, 'ok'); assert.equal(s.fetch_complete, true)
})

test('tfFetchMany: the per-scan fetch cap still binds (cap 25 never exceeded, 30 urls -> 25 requested)', async () => {
  const db = mk(); const log: string[][] = []
  const urls = Array.from({ length: 30 }, (_, i) => `https://s${i}.example/p`)
  const r = await tfFetchMany(db, 't1', urls, { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher(log) })
  assert.equal(log.flat().length, 25); assert.ok(r.ok && r.pages.length === 25)
})

test('tfFetchMany: a later batch failing keeps earlier pages; the page count is marked a lower bound', async () => {
  const db = mk(); const log: string[][] = []; const trace = new SearchTrace()
  const urls = Array.from({ length: 25 }, (_, i) => `https://s${i}.example/p`)
  const r = await tfFetchMany(db, 't1', urls, { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher(log, [2]), trace })
  assert.ok(r.ok && r.pages.length === 10); assert.equal(log.length, 2, 'stops after a provider failure')
  const s = summarizeTrace(trace); assert.equal(s.fetch_requested, 20); assert.equal(s.fetch_pages_with_text, 10); assert.equal(s.fetch_outcome, 'unavailable'); assert.equal(s.fetch_complete, false)
})

test('tfFetchMany: first batch failing returns the failure', async () => {
  const db = mk(); const r = await tfFetchMany(db, 't1', ['https://a.example/x'], { fetches: 0 }, { env, now: NOW, fetchImpl: fetcher([], [1]) })
  assert.deepEqual(r, { ok: false, reason: 'unavailable' })
})
