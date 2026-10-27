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
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { isLoginWalled, pickFetchUrls, queryPrompt, sanitizeQueries, toEvidence, windowAfter } from '../lib/search/tinyfish.ts'

// Source selection and dated evidence, from the live acceptance run of 2026-10-26 (#204): the NYC dental search's only
// candidate was an undated, login-walled Facebook group post; the London search found nothing. The saved jobs are not
// available to the builder, so these are STUBBED fixtures of the code paths (not a reproduction of those results and not
// proof of better live yield). No gate is touched: window, quote, identity and date checks run after all of this.

test('login-walled hosts are recognised by exact host or subdomain, nothing else', () => {
  for (const u of ['https://www.facebook.com/groups/x/posts/1', 'https://m.facebook.com/a', 'https://instagram.com/p/1', 'https://nextdoor.com/p/1', 'https://www.linkedin.com/in/x']) assert.equal(isLoginWalled(u), true, u)
  for (const u of ['https://facebook.com.evil.example/x', 'https://notfacebook.com/x', 'https://news.example/facebook.com', 'not a url']) assert.equal(isLoginWalled(u), false, u)
})

test('fetch slots go to readable hosts first; walled hosts are demoted, never dropped', () => {
  const urls = ['https://www.facebook.com/groups/g/posts/1', 'https://a.example/1', 'https://www.facebook.com/groups/g/posts/2', 'https://b.example/1', 'https://c.example/1', 'https://nextdoor.com/p/1']
  assert.deepEqual(pickFetchUrls(urls, 3), ['https://a.example/1', 'https://b.example/1', 'https://c.example/1'])
  const all = pickFetchUrls(urls, 10)
  assert.equal(all.length, 6); assert.deepEqual(all.slice(0, 3), ['https://a.example/1', 'https://b.example/1', 'https://c.example/1'])
  assert.ok(all.includes('https://www.facebook.com/groups/g/posts/1') && all.includes('https://nextdoor.com/p/1'), 'nothing excluded')
})

test('the 30-item evidence cap is not filled by snippet-only walled results ahead of readable pages', () => {
  const hits = [
    ...Array.from({ length: 30 }, (_, i) => ({ url: `https://www.facebook.com/groups/g/posts/${i}`, title: 'post', snippet: 'a long enough snippet about a dental practice opening', date: null })),
    { url: 'https://news.example/real', title: 'real', snippet: 'a long enough snippet about a dental practice opening', date: '2026-10-10' },
  ]
  const ev = toEvidence(hits, [])
  assert.equal(ev.length, 30); assert.equal(ev[0].url, 'https://news.example/real')
})

test('model-written site: targets on social networks are removed unless the request names them', () => {
  assert.deepEqual(sanitizeQueries(['dental practice new location site:facebook.com Brooklyn', 'dental opening site:nextdoor.com NYC', 'dental practice "now hiring" New York'], 'dental practices in NYC'),
    ['dental practice new location Brooklyn', 'dental opening NYC', 'dental practice "now hiring" New York'])
  assert.deepEqual(sanitizeQueries(['dental practice site:facebook.com Brooklyn'], 'dental practices on facebook.com in NYC'), ['dental practice site:facebook.com Brooklyn'])
})

test('query prompt carries the USER window, skip list, and the readable/dated-source preference', () => {
  const p = queryPrompt('Find NYC dental practices opened in the past 90 days', { window_days: 90, exclude: ['chains', 'dental software vendors'], language: 'en' }, 6)
  assert.match(p, /already limited to the last 90 days/); assert.doesNotMatch(p, /last year/)
  assert.match(p, /skip: \["chains","dental software vendors"\]/)
  assert.match(p, /publication date and can be read without logging in/); assert.match(p, /Facebook, Instagram, Nextdoor, LinkedIn\) need a login/)
  assert.match(queryPrompt('q', { exclude: [] }, 3), /already limited to the last year/, 'no window: unchanged wording')
})

test('search window follows the user window, never wider than 365 days; malformed windows fall back to the default', () => {
  const now = new Date('2026-10-26T12:00:00Z')
  assert.equal(windowAfter(90, now), '2026-07-28'); assert.equal(windowAfter(365, now), '2025-10-26')
  for (const bad of [null, undefined, 0, -5, 30.5, 400, NaN]) assert.equal(windowAfter(bad as never, now), '2025-10-26', String(bad))
})

// End to end through the real runner with a stubbed TinyFish: the search carries the user's window, and hiring-board
// queries take at most half of the search budget (three places used to take 6 of 8).
const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
test('runner: after_date is the 90-day cutoff; with three places at most 4 of the 8 searches are applicant-tracking queries', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Dental practices', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York', 'Brooklyn', 'Queens'], signals: ['hiring a receptionist'], exclude: ['chains'], window_days: 90 }
  createQueryJob(db, 'A', { query: 'Independent dental practices hiring a receptionist or office manager in New York, Brooklyn or Queens in the past 90 days', icp: JSON.stringify(icp) })
  const job = claimKeyedJob(db)!
  const searches: { query: string; after: string | null }[] = []
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) { const q = new URL(u).searchParams; if (!q.get('query')!.startsWith('site:linkedin.com/in ')) searches.push({ query: q.get('query')!, after: q.get('after_date') }); return new Response(JSON.stringify({ results: [] }), { status: 200 }) }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async (_k, _p, _f, maxTokens) => maxTokens === 300 ? JSON.stringify(['dental office now hiring receptionist Brooklyn', 'dental practice office manager job Queens', 'new dental practice opening New York', 'dental front desk coordinator hiring NYC', 'dental clinic expansion Brooklyn']) : '[]' },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; process.env.TINYFISH_API_KEY = 'tf-test'
  try { await runJob(db, job, { providers, master, fetchPage: async () => null as never, fetchImpl, judge: null, score: false, ground: false }) } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
  assert.ok(searches.length >= 1 && searches.length <= 8, `searches=${searches.length}`)
  const expected = windowAfter(90)
  assert.ok(searches.every(s => s.after === expected), `after_date should be ${expected}: ${JSON.stringify(searches.map(s => s.after))}`)
  const ats = searches.filter(s => /site:(?:boards|job-boards)\.greenhouse\.io|site:jobs\.(?:ashbyhq\.com|lever\.co)/.test(s.query))
  assert.ok(ats.length >= 1 && ats.length <= 4, `ATS queries ${ats.length} of ${searches.length}`)
  assert.ok(searches.length - ats.length >= 4, 'at least half the budget stays for open searches')
})

// Fetch slots are scarce (16 of ~80 results): order by how likely a page can still pass the window gate.
test('pickFetchUrls with a rank: lower rank first across and within hosts, ties keep search order, nothing dropped with room', () => {
  const urls = ['https://a.example/old', 'https://b.example/undated', 'https://a.example/new', 'https://c.example/new', 'https://www.facebook.com/g/1']
  const rank = (u: string) => (u.endsWith('/new') ? 0 : u.endsWith('/undated') ? 1 : u.includes('facebook') ? 3 : 2)
  assert.deepEqual(pickFetchUrls(urls, 3, rank), ['https://a.example/new', 'https://c.example/new', 'https://b.example/undated'])
  const all = pickFetchUrls(urls, 10, rank); assert.equal(all.length, 5); assert.equal(all[all.length - 1], 'https://www.facebook.com/g/1')
  assert.deepEqual(pickFetchUrls(urls, 10), pickFetchUrls(urls, 10), 'deterministic')
})

test('runner: with a 90-day window, in-window dated results are fetched before undated, stale and walled ones when the fetch cap bites', async () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Dental practices', who: ['Practice manager'], industries: [], sizes: [], where: ['New York'], signals: ['opening'], exclude: [], window_days: 90 }
  createQueryJob(db, 'A', { query: 'New dental practices opened in New York in the past 90 days', icp: JSON.stringify(icp) })
  const job = claimKeyedJob(db)!
  const results = [
    { url: 'https://stale.example/a', title: 's', snippet: 'a long enough snippet about a dental practice opening', date: day(-300) },
    { url: 'https://www.facebook.com/groups/g/posts/1', title: 'f', snippet: 'a long enough snippet about a dental practice opening', date: null },
    { url: 'https://undated.example/a', title: 'u', snippet: 'a long enough snippet about a dental practice opening', date: null },
    { url: 'https://fresh1.example/a', title: 'n1', snippet: 'a long enough snippet about a dental practice opening', date: day(-5) },
    { url: 'https://fresh2.example/a', title: 'n2', snippet: 'a long enough snippet about a dental practice opening', date: day(-20) },
  ]
  let fetched: string[] = []
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: new URL(u).searchParams.get('query')!.startsWith('site:linkedin.com/in ') ? [] : results }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) { fetched.push(...JSON.parse(String(init?.body)).urls); return new Response(JSON.stringify({ results: [] }), { status: 200 }) }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const providers: Record<'anthropic' | 'openai', Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async () => '[]' }, openai: { research: async () => ({ text: '', citedUrls: [] }) } }
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; process.env.TINYFISH_API_KEY = 'tf-test'; process.env.TINYFISH_FETCHES_PER_SCAN = '2'
  try { await runJob(db, job, { providers, master, fetchPage: async () => null as never, fetchImpl, judge: null, score: false, ground: false }) } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY; delete process.env.TINYFISH_FETCHES_PER_SCAN }
  assert.deepEqual(fetched.slice(0, 2).sort(), ['https://fresh1.example/a', 'https://fresh2.example/a'], `fetch cap of 2 goes to the in-window dated pages, got ${JSON.stringify(fetched)}`)
})

// Instinct #219 review (eab7fff): the preferred result was FETCHED but toEvidence then walked search order and sliced to 30,
// dropping it before the model saw it. The extraction cap now follows the same ranking.
const mkHits = (n: number, dated: Record<number, string>) => Array.from({ length: n }, (_, i) => ({ url: `https://host${i}.example/post`, title: `t${i}`, snippet: `a long enough snippet number ${i} about a dental practice opening`, date: dated[i] ?? null }))
test('toEvidence: a preferred late result survives the 30-item cap; breadth, undated handling and the old default order are kept', () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const hits = mkHits(40, { 39: day(-5) })
  const rank = (u: string) => (u === 'https://host39.example/post' ? 0 : 1)
  const withRank = toEvidence(hits, [], rank)
  assert.equal(withRank.length, 30); assert.equal(withRank[0].url, 'https://host39.example/post', 'preferred result leads')
  assert.ok(withRank.slice(1).every((e, i) => e.url === `https://host${i}.example/post`), 'the rest keep search order (undated results are not reordered or dropped before the cap)')
  assert.ok(!toEvidence(hits, []).some(e => e.url === 'https://host39.example/post'), 'old behaviour (no rank): cut by the cap - the reported gap')
  // a fetched page beats a snippet-only result of the same rank, and breadth: first pages of distinct hosts before second pages
  const two = [{ url: 'https://a.example/1', title: 'a1', snippet: 'a long enough snippet about a dental practice opening', date: null }, { url: 'https://a.example/2', title: 'a2', snippet: 'a long enough snippet about a dental practice opening', date: null }, { url: 'https://b.example/1', title: 'b1', snippet: 'a long enough snippet about a dental practice opening', date: null }, { url: 'https://c.example/1', title: 'c1', snippet: 'a long enough snippet about a dental practice opening', date: null }]
  assert.deepEqual(toEvidence(two, [{ url: 'https://c.example/1', title: 'c', text: 'Full article text about the opening of the new dental practice in Brooklyn.' }], () => 0, 3).map(e => e.url), ['https://c.example/1', 'https://a.example/1', 'https://b.example/1'])
})

test('runner: 40 readable hosts, only result #39 is dated inside the 90-day window - its fetched article body reaches the extraction prompt', async () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Dental practices', who: ['Practice manager'], industries: [], sizes: [], where: ['New York'], signals: ['opening'], exclude: [], window_days: 90 }
  createQueryJob(db, 'A', { query: 'New dental practices opened in New York in the past 90 days', icp: JSON.stringify(icp) })
  const job = claimKeyedJob(db)!
  const hits = mkHits(40, { 39: day(-5) })
  let extraction = ''; let call = 0
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    // A search returns at most 10 results, so 5 searches bring 50 results over time; result #39 arrives with the 4th search.
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: new URL(u).searchParams.get('query')!.startsWith('site:linkedin.com/in ') ? [] : hits.slice(call * 10, call++ * 10 + 10) }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: (JSON.parse(String(init?.body)).urls as string[]).map(url => ({ url, title: 'page', text: `BODY-OF-${new URL(url).hostname}: the practice announced its opening in Brooklyn this month with a new front desk team.` })) }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const providers: Record<'anthropic' | 'openai', Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async (_k, p, _f, max) => { if (p.startsWith('You turn pre-collected')) extraction = p; return max === 300 ? '["dental practice opening Brooklyn","new dental clinic Queens","dental office expansion Manhattan","dental practice new location Bronx","dentist opens second office Staten Island"]' : '[]' } }, openai: { research: async () => ({ text: '', citedUrls: [] }) } }
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; process.env.TINYFISH_API_KEY = 'tf-test'
  try { await runJob(db, job, { providers, master, fetchPage: async () => null as never, fetchImpl, judge: null, score: false, ground: false }) } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
  assert.ok(extraction.length > 0, 'fixture precondition: extraction was reached')
  console.log('DBG', extraction.includes('host39.example'), (extraction.match(/host\d+\.example/g) ?? []).slice(0, 12).join(','), extraction.length)
  assert.ok(extraction.includes('BODY-OF-host39.example'), 'the preferred, fetched article body is in the extraction prompt')
  const nItems = (extraction.match(/BODY-OF-host\d+\.example/g) ?? []).length
  assert.ok(nItems >= 10 && nItems <= 16, `fetched bodies reach the model (breadth kept): ${nItems}`)
})
