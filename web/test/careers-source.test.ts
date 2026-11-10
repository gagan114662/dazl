// #767 (part of #388): first-party careers source adapter. Synthetic, inline fixtures (invented company "Brightloop", no network): stubbed SafeGet answers only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { careersAdapter, careersLimits, siteOf, SALES_ASK } from '../lib/sources/careers.ts'
import { collectEvidenceReport, normalizeSources, ADAPTERS } from '../lib/sources/index.ts'
import { byId, availability, advertisable, sourceStatusLine } from '../lib/sources/capability-matrix.ts'
import type { HttpResult, SafeGet } from '../lib/sources/types.ts'

const REQ = 'London B2B SaaS startups hiring sales staff'
const page = (b: string) => `<html><body>${b}</body></html>`
const INDEX = '<h2>Open roles</h2><ul><li>Backend Engineer</li><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul>'
const JOB = '<h1>Account Executive - London</h1><p>Join Brightloop in London as Account Executive - London and own the full sales cycle.</p><a href="/careers/apply">Apply</a>'
// Serves host/path -> body (200); anything else is a 404. Every URL asked is logged.
const site = (pages: Record<string, string>, asked: string[] = [], over: Record<string, HttpResult | null> = {}): SafeGet => async url => {
  asked.push(url); const u = new URL(url); const key = u.hostname + u.pathname
  if (key in over) return over[key]
  if (u.pathname === '/robots.txt' && !(key in pages)) return { status: 404, body: '' }
  return key in pages ? { status: 200, body: page(pages[key]) } : { status: 404, body: '' }
}
const run = (http: SafeGet, o: { query?: string; pages?: string[]; companies?: { name: string; domain?: string | null }[] } = {}) => {
  const notes: Record<string, number> = {}
  return careersAdapter.collect({ query: o.query ?? REQ, keywords: [], feeds: [], pages: o.pages ?? ['https://brightloop.io'], companies: o.companies, http, note: c => { notes[c] = (notes[c] ?? 0) + 1 } }).then(items => ({ items, notes }))
}
const OPEN = { 'brightloop.io/careers': INDEX, 'brightloop.io/careers/ae': JOB }

test('an open sales role on the company\'s own careers page becomes evidence that cites the specific job page, undated', async () => {
  const { items, notes } = await run(site(OPEN))
  assert.equal(items.length, 1); assert.deepEqual(notes, {})
  const e = items[0]
  assert.equal(e.source, 'careers'); assert.equal(e.url, 'https://brightloop.io/careers/ae', 'the job page, not the careers index')
  assert.match(e.title, /Account Executive - London.*brightloop\.io/); assert.ok(e.quote.length >= 20 && e.quote.length <= 300)
  assert.equal(e.date, null, 'an own-domain job page does not date itself: the retrieval day is never used')
  assert.ok(JOB.includes(e.quote.replace(/\s+/g, ' ').slice(0, 25)) || /Account Executive/.test(e.quote))
})

test('a company with a domain is read as well as a listed page; a repeated site is read once', async () => {
  const asked: string[] = []
  const { items } = await run(site(OPEN, asked), { pages: ['https://www.brightloop.io/careers'], companies: [{ name: 'Brightloop', domain: 'brightloop.io' }] })
  assert.equal(items.length, 1); assert.equal(asked.filter(u => u.endsWith('/robots.txt')).length, 1)
})

test('same-site redirects (apex -> www) are followed; the redirected page still proves the role', async () => {
  const http: SafeGet = async url => {
    const u = new URL(url)
    if (u.hostname === 'brightloop.io') return { status: 301, body: '', location: `https://www.brightloop.io${u.pathname}` }
    const body = { '/careers': INDEX, '/careers/ae': JOB }[u.pathname]
    return u.pathname === '/robots.txt' || body === undefined ? { status: 404, body: '' } : { status: 200, body: page(body) }
  }
  const { items } = await run(http)
  assert.equal(items.length, 1); assert.equal(items[0].url, 'https://www.brightloop.io/careers/ae')
})

test('negative fixtures: no sales role, closed marker, no careers page, robots disallow, off-site redirect all give no evidence and no partial note', async () => {
  const none = async (pages: Record<string, string>, over: Record<string, HttpResult | null> = {}) => run(site(pages, [], over))
  for (const [name, pages, over] of [
    ['engineering only', { 'brightloop.io/careers': '<li>Backend Engineer</li><li>Data Scientist</li> Apply' }, {}],
    ['hiring sentence', { 'brightloop.io/careers': '<p>We are growing our go-to-market. Apply soon.</p>' }, {}],
    ['closed', { 'brightloop.io/careers': '<p>There are no open positions right now.</p>' }, {}],
    ['no careers page', {}, {}],
    ['robots disallow', OPEN, { 'brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' } }],
    ['job page closed', { ...OPEN, 'brightloop.io/careers/ae': '<h1>Account Executive - London</h1><p>This position has been filled.</p>' }, {}],
    ['job page is a different role', { ...OPEN, 'brightloop.io/careers/ae': '<h1>Backend Engineer</h1><p>Join Brightloop.</p>' }, {}],
    ['job page 404', { 'brightloop.io/careers': INDEX }, {}],
    ['off-site redirect', {}, { 'brightloop.io/careers': { status: 301, body: '', location: 'https://othercorp.com/careers' } }],
  ] as [string, Record<string, string>, Record<string, HttpResult | null>][]) {
    const r = await none(pages, over); assert.deepEqual(r.items, [], name); assert.deepEqual(r.notes, {}, `${name}: a definite no is a healthy empty, not a partial`)
  }
})

test('a failed read is partial (unreachable), never a healthy empty: robots, careers page and job page failures', async () => {
  for (const over of [{ 'brightloop.io/robots.txt': null }, { 'brightloop.io/careers': null }, { 'brightloop.io/careers/ae': null }, { 'brightloop.io/careers/ae': { status: 302, body: '' } }] as Record<string, HttpResult | null>[]) {
    const r = await run(site(OPEN, [], over)); assert.deepEqual(r.items, [], JSON.stringify(over)); assert.equal(r.notes.unreachable, 1, JSON.stringify(over))
  }
})

test('out of coverage is skipped, not empty: no sales role asked, no company site given, non-https / lookalike / IP sites', async () => {
  const asked: string[] = []
  assert.deepEqual((await run(site(OPEN, asked), { query: 'Find dentists opening a second clinic' })).notes, { out_of_coverage: 1 })
  assert.deepEqual((await run(site(OPEN, asked), { pages: [] })).notes, { out_of_coverage: 1 })
  assert.deepEqual((await run(site(OPEN, asked), { pages: ['http://brightloop.io', 'https://127.0.0.1/careers', 'https://user:pw@brightloop.io', 'https://brightloop.io:8443/x', 'javascript:alert(1)', 'brightloop'] })).notes, { out_of_coverage: 1 })
  assert.deepEqual(asked, [], 'no request for a request outside coverage')
  assert.equal(siteOf('https://www.Brightloop.io/careers?x=1'), 'brightloop.io'); assert.equal(siteOf('brightloop.io'), 'brightloop.io')
})

test('the per-scan budget and site cap bound the reads and report partial', async () => {
  const many = Array.from({ length: 6 }, (_, i) => `https://co${i}.io`)
  const asked: string[] = []
  const r = await run(site({}, asked), { pages: many })
  assert.equal(new Set(asked.map(u => new URL(u).hostname)).size, careersLimits.maxSites); assert.equal(r.notes.site_cap, 1)
  const real = careersLimits.now; let t = 0; careersLimits.now = () => (t += 20_000)
  try { const b = await run(site(OPEN)); assert.deepEqual(b.items, []); assert.ok(b.notes.budget >= 1 && b.notes.unreachable === 1, 'a spent budget is partial, not "no vacancy"') } finally { careersLimits.now = real }
})

test('an ATS-linked posting carries the board\'s own publish date (never the retrieval day)', async () => {
  const idx = '<ul><li><a href="https://jobs.lever.co/brightloop/abc-123">Account Executive</a></li></ul>'
  const http: SafeGet = async url => {
    const u = new URL(url)
    if (u.hostname === 'api.lever.co') return { status: 200, body: JSON.stringify({ text: 'Account Executive', descriptionPlain: 'Brightloop is hiring an Account Executive to own the sales cycle end to end.', createdAt: Date.parse('2026-10-20T09:00:00Z') }) }
    if (u.pathname === '/careers') return { status: 200, body: page(idx) }
    return { status: 404, body: '' }
  }
  const { items } = await run(http)
  assert.equal(items.length, 1); assert.equal(items[0].url, 'https://jobs.lever.co/brightloop/abc-123'); assert.equal(items[0].date, '2026-10-20')
})

test('registered end to end: selectable, reported as an adapter run, and the matrix says what it is (and is not)', async () => {
  assert.ok(ADAPTERS.careers); assert.deepEqual(normalizeSources({ adapters: ['careers'], pages: ['https://brightloop.io'] }), { adapters: ['careers'], feeds: [], pages: ['https://brightloop.io'] })
  const ok = await collectEvidenceReport({ adapters: ['careers'], feeds: [], pages: ['https://brightloop.io'] }, REQ, site(OPEN))
  assert.deepEqual(ok.runs, [{ collector: 'adapter:careers', status: 'ok', evidence: 1 }]); assert.equal(ok.items.length, 1)
  const skipped = await collectEvidenceReport({ adapters: ['careers'], feeds: [], pages: [] }, REQ, site(OPEN))
  assert.equal(skipped.runs[0].status, 'skipped_out_of_coverage'); assert.equal(skipped.runs[0].evidence, null)
  const partial = await collectEvidenceReport({ adapters: ['careers'], feeds: [], pages: ['https://brightloop.io'] }, REQ, site(OPEN, [], { 'brightloop.io/robots.txt': null }))
  assert.equal(partial.runs[0].status, 'partial')
  const c = byId('careers')!
  assert.equal(c.status, 'shipped'); assert.equal(availability(c, { workers: new Set() }), 'available'); assert.equal(advertisable(c), false, 'no live source-to-lead evidence yet: not advertised')
  assert.equal(byId('first-party-careers'), undefined)
  assert.match(sourceStatusLine(c, 'available', { status: 'skipped_out_of_coverage', evidence: null }), /./)
})

test('a bare "revenue" is not a sales-role ask (Ziggy #1034 note 2); revenue ROLE phrasing still is', async () => {
  for (const q of ['companies with revenue growth', 'SaaS firms over $10m revenue', 'revenue-based financing startups', 'revenues up 20%']) {
    const asked: string[] = []
    assert.equal(SALES_ASK.test(q), false, q)
    assert.deepEqual((await run(site(OPEN, asked), { query: q })).notes, { out_of_coverage: 1 }, q); assert.deepEqual(asked, [], `${q}: nothing read`)
  }
  for (const q of ['startups hiring a Chief Revenue Officer', 'companies hiring a head of revenue', 'building a revenue team', 'VP of Revenue openings', 'revenue operations hires', 'hiring sales staff', 'SDR roles', 'go-to-market hires']) assert.equal(SALES_ASK.test(q), true, q)
  assert.equal(SALES_ASK.test('x'.repeat(200_000) + ' revenue'), false, 'huge input: linear, no match')
})
