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

// The adapter's own input.companies handling: tested here directly, though no runner path passes a company domain yet (see careers.ts header).
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
  assert.match(c.license, /only the company sites listed in the scan's pages/); assert.doesNotMatch(c.license, /companies with a domain/, 'no runner path passes company domains yet (Hermes-PC 5 at 41a445fa)')
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

// ---- Greptile review round (#1034): each test fails on the previous behaviour ----
test('review: a redirect into a path robots.txt disallows is never fetched', async () => {
  const asked: string[] = []
  const http: SafeGet = async url => {
    asked.push(url); const u = new URL(url)
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nDisallow: /private/' }
    if (u.pathname === '/careers') return { status: 301, body: '', location: '/private/jobs' }
    return { status: 200, body: page(INDEX) }
  }
  const { items } = await run(http)
  assert.equal(items.length, 0)
  assert.ok(!asked.some(u => u.includes('/private/jobs')), 'the disallowed redirect target was not requested')
})

test('review: 403 / 429 / 500 pages and a blocked robots.txt are unreachable, not an empty market; 404 stays a definite absence', async () => {
  for (const status of [403, 429, 500]) {
    const r = await run(site({}, [], { 'brightloop.io/careers': { status, body: '' } }))
    assert.equal(r.items.length, 0); assert.equal(r.notes.unreachable, 1, `status ${status} says nothing about hiring`)
  }
  for (const status of [401, 403, 429]) {
    const asked: string[] = []
    const r = await run(site(OPEN, asked, { 'brightloop.io/robots.txt': { status, body: '' } }))
    assert.equal(r.items.length, 0); assert.equal(r.notes.unreachable, 1, `robots ${status}`)
    assert.ok(!asked.some(u => u.endsWith('/careers')), `robots ${status}: no page is read around it`)
  }
  assert.deepEqual((await run(site({}))).notes, {}, '404 careers page: genuinely nothing, no partial note')
})

test('review: a redirect target\'s own robots.txt that itself redirects is unreachable, never parsed as "no rules"', async () => {
  // robotsOf's own fetch (checking the TARGET of a redirect before following into it) does not follow redirects
  // itself. A 3xx there must not fall through to parseRobots on its (empty/unrelated) body, which would silently
  // read as "no restrictions" and let a page a real robots.txt might disallow through unexamined.
  const asked: string[] = []
  const r = await run(site(OPEN, asked, {
    'brightloop.io/careers': { status: 301, body: '', location: 'https://www.brightloop.io/careers' },
    'www.brightloop.io/robots.txt': { status: 301, body: '', location: 'https://www.brightloop.io/other-robots.txt' },
  }))
  assert.equal(r.items.length, 0)
  assert.equal(r.notes.unreachable, 1, 'an unresolved robots.txt redirect says nothing about hiring, never a healthy empty')
  assert.ok(!asked.some(u => u.endsWith('www.brightloop.io/careers')), 'the redirect target was never fetched without resolved robots rules')
})

test('review: a page cut at the byte cap is a partial read; a cut robots.txt is not permission', async () => {
  const r = await run(site({}, [], { 'brightloop.io/careers': { status: 200, body: page('<h2>Open roles</h2>'), truncated: true } }))
  assert.equal(r.notes.unreachable, 1)
  const asked: string[] = []
  const r2 = await run(site(OPEN, asked, { 'brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /', truncated: true } }))
  assert.equal(r2.items.length, 0); assert.ok(!asked.some(u => u.endsWith('/careers')))
})

test('review: the budget is checked before every redirect hop', async () => {
  let t = 0; const saved = careersLimits.now; careersLimits.now = () => t
  try {
    const http: SafeGet = async url => { t += 8_000; return new URL(url).pathname === '/robots.txt' ? { status: 404, body: '' } : { status: 301, body: '', location: `${url}/` } }
    const { notes } = await run(http); assert.ok(notes.budget >= 1)
  } finally { careersLimits.now = saved }
})

test('review: a supplied careers path is read first, even when nothing links to it', async () => {
  const asked: string[] = []
  const { items } = await run(site({ 'brightloop.io/opportunities': INDEX, 'brightloop.io/careers/ae': JOB }, asked), { pages: ['https://brightloop.io/opportunities'] })
  assert.equal(items.length, 1)
  const reads = asked.filter(u => !u.endsWith('/robots.txt')).map(u => new URL(u).pathname)
  assert.equal(reads[1] ?? reads[0], reads.find(p => p !== '/') ); assert.ok(reads.indexOf('/opportunities') < reads.indexOf('/careers') || !reads.includes('/careers'))
})

test('review: every GTM role family the reader accepts is asked for; "revenue growth" still is not', () => {
  for (const q of ['companies hiring customer success managers', 'firms hiring account managers', 'partnerships hires', 'hiring solutions engineers', 'growth marketers wanted', 'head of growth']) assert.match(q, SALES_ASK, q)
  for (const q of ['companies with revenue growth', 'high growth startups', 'partnership with Google']) assert.doesNotMatch(q, SALES_ASK, q)
})

test('review: the careers read is sent under the token its robots.txt rules were read for', async () => {
  const uas = new Set<string>()
  const http: SafeGet = async (_url, o) => { uas.add(o?.headers?.['user-agent'] ?? ''); return { status: 404, body: '' } }
  await run(http); assert.ok([...uas].every(u => u.startsWith('dazl-contact-check')), [...uas].join())
})

test('review (Quest #1034): non-string input entries are skipped, never a crash; the valid entries are still read', async () => {
  const junk = [null, undefined, 42, true, {}, [], ['https://brightloop.io'], { href: 'https://brightloop.io' }] as unknown as string[]
  const { items } = await run(site(OPEN), { pages: [...junk, 'https://brightloop.io'], companies: [null, 7, 'brightloop.io', [], { name: 9, domain: 12 }, { name: null, domain: ['brightloop.io'] }, { name: 'Brightloop', domain: { host: 'x.io' } }] as unknown as { name: string; domain?: string | null }[] })
  assert.equal(items.length, 1, 'the one valid page is still read'); assert.equal(items[0].url, 'https://brightloop.io/careers/ae')
  const only = await run(site(OPEN), { pages: junk, companies: [null, { name: 1, domain: 2 }] as unknown as { name: string; domain?: string | null }[] })
  assert.deepEqual(only.items, []); assert.deepEqual(only.notes, { out_of_coverage: 1 }, 'nothing usable given = out of coverage, not a crash and not an empty market')
  const weird = await careersAdapter.collect({ query: REQ, keywords: [], feeds: [], pages: 'https://brightloop.io' as unknown as string[], companies: { name: 'x' } as unknown as [], http: site(OPEN) })
  assert.deepEqual(weird, [], 'a non-array pages / companies value is ignored')
  const q = await careersAdapter.collect({ query: null as unknown as string, keywords: [], feeds: [], pages: ['https://brightloop.io'], http: site(OPEN) })
  assert.deepEqual(q, [])
  for (const v of [null, undefined, 3, {}, []]) { assert.equal(siteOf(v as unknown as string), null) }
})

// ---- Hermes-PC review at f1ea51b5 (each failing before its fix) ----
test('review (Hermes-PC 1): a direct job link on a sibling host is checked against THAT host\'s robots.txt; a disallowed path is never fetched', async () => {
  const asked: string[] = []
  const r = await run(site({ 'brightloop.io/careers': '<h2>Open roles</h2><ul><li><a href="https://jobs.brightloop.io/private/ae">Account Executive - London</a></li></ul>', 'jobs.brightloop.io/private/ae': JOB }, asked, {
    'jobs.brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private' },
  }))
  assert.deepEqual(r.items, [], 'no evidence from a path its own host disallows')
  assert.ok(asked.includes('https://jobs.brightloop.io/robots.txt'), 'the sibling host\'s own robots.txt was read')
  assert.ok(!asked.includes('https://jobs.brightloop.io/private/ae'), 'the disallowed job page was never requested')
})

test('review (Hermes-PC 2): a target host\'s robots.txt answering 400 or 451 is unreachable, not "no policy"; only 404 / 410 allow all', async () => {
  for (const status of [400, 451]) {
    const asked: string[] = []
    const r = await run(site(OPEN, asked, {
      'brightloop.io/careers/ae': { status: 301, body: '', location: 'https://jobs.brightloop.io/private/ae' },
      'jobs.brightloop.io/robots.txt': { status, body: '' },
    }))
    assert.deepEqual(r.items, [], `robots ${status}`); assert.equal(r.notes.unreachable, 1, `robots ${status}: a partial read, not a healthy empty`)
    assert.ok(!asked.includes('https://jobs.brightloop.io/private/ae'), `robots ${status}: the target was never fetched`)
  }
  for (const status of [404, 410]) {
    const r = await run(site({ ...OPEN, 'jobs.brightloop.io/careers/ae': JOB }, [], {
      'brightloop.io/careers/ae': { status: 301, body: '', location: 'https://jobs.brightloop.io/careers/ae' },
      'jobs.brightloop.io/robots.txt': { status, body: '' },
    }))
    assert.equal(r.items.length, 1, `robots ${status}: no policy, the target is read`)
  }
})

test('review (Hermes-PC 3): shared-host tenants are different companies: alice.github.io never cites bob.github.io\'s posting', async () => {
  const asked: string[] = []
  const r = await run(site({ 'alice.github.io/careers': '<h2>Open roles</h2><ul><li><a href="https://bob.github.io/jobs/ae">Account Executive - London</a></li></ul>', 'bob.github.io/jobs/ae': JOB }, asked), { pages: ['https://alice.github.io'] })
  assert.deepEqual(r.items, [])
  assert.ok(!asked.some(u => u.startsWith('https://bob.github.io/')), 'another tenant\'s page is not read as this company\'s')
})

test('review (Hermes-PC 4): no robots.txt request starts after the budget ran out while a page was loading', async () => {
  let t = 0; const saved = careersLimits.now; careersLimits.now = () => t
  const starts: { url: string; t: number }[] = []
  try {
    const inner = site(OPEN, [], { 'brightloop.io/careers': { status: 301, body: '', location: 'https://www.brightloop.io/careers' } })
    const http: SafeGet = async (url, o) => {
      starts.push({ url, t }); const r = await inner(url, o)
      if (url === 'https://brightloop.io/careers') t = 20_000 // the clock when the /careers redirect comes back (budget 12 000 ms)
      return r
    }
    const r = await run(http)
    assert.deepEqual(starts.filter(s => s.t > careersLimits.budgetMs), [], 'late starts')
    assert.ok(r.notes.budget >= 1); assert.equal(r.notes.unreachable, 1, 'a spent budget is partial')
  } finally { careersLimits.now = saved }
})

// ---- independent review at 5279ab42 ----
test('review R1: a page whose path merely ends in /robots.txt is checked like any page and never taken as the host\'s robots rules', async () => {
  const asked: string[] = []
  const idx = '<h2>Open roles</h2><ul><li><a href="https://jobs.brightloop.io/private/a/robots.txt">Sales Development Representative</a></li><li><a href="https://jobs.brightloop.io/private/ae">Account Executive - London</a></li></ul>'
  const r = await run(site({ 'brightloop.io/careers': idx, 'jobs.brightloop.io/private/ae': JOB }, asked, {
    'jobs.brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private' },
  }))
  assert.deepEqual(r.items, [])
  assert.ok(asked.includes('https://jobs.brightloop.io/robots.txt'), 'the host\'s real robots.txt was read')
  assert.ok(!asked.includes('https://jobs.brightloop.io/private/a/robots.txt'), 'the disallowed look-alike page was not fetched')
  assert.ok(!asked.includes('https://jobs.brightloop.io/private/ae'), 'the disallowed job page was not fetched')
})

const ASHBY_IDX = '<ul><li><a href="https://jobs.ashbyhq.com/brightloop/ae-1">Account Executive</a></li></ul>'
const ASHBY_BOARD = JSON.stringify({ jobs: [{ jobUrl: 'https://jobs.ashbyhq.com/brightloop/ae-1', isListed: true, title: 'Account Executive', descriptionPlain: 'Brightloop is hiring an Account Executive to own the sales cycle end to end.', publishedAt: '2026-10-20T09:00:00Z' }] })
test('review R2: the public ATS JSON API is read even though its robots.txt answers 401 (the documented API is not a crawled page)', async () => {
  const asked: string[] = []
  const r = await run(site({ 'brightloop.io/careers': ASHBY_IDX }, asked, {
    'api.ashbyhq.com/robots.txt': { status: 401, body: 'Unauthorized' },
    'api.ashbyhq.com/posting-api/job-board/brightloop': { status: 200, body: ASHBY_BOARD },
  }))
  assert.equal(r.items.length, 1, JSON.stringify(r.notes)); assert.equal(r.items[0].url, 'https://jobs.ashbyhq.com/brightloop/ae-1'); assert.equal(r.items[0].date, '2026-10-20')
  assert.ok(!asked.includes('https://api.ashbyhq.com/robots.txt'), 'the ATS API host is not robots-checked')
})
test('review R2: a look-alike of an ATS API host is robots-checked like any other host', async () => {
  const asked: string[] = []
  const r = await run(site({ 'ashbyhq.com.evil.io/careers': '<ul><li><a href="https://api.ashbyhq.com.evil.io/jobs/ae">Account Executive - London</a></li></ul>', 'api.ashbyhq.com.evil.io/jobs/ae': JOB }, asked, {
    'api.ashbyhq.com.evil.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /jobs' },
  }), { pages: ['https://ashbyhq.com.evil.io'] })
  assert.deepEqual(r.items, [])
  assert.ok(asked.includes('https://api.ashbyhq.com.evil.io/robots.txt'), 'the look-alike host\'s robots.txt was read')
  assert.ok(!asked.includes('https://api.ashbyhq.com.evil.io/jobs/ae'), 'and obeyed')
})

test('review R4: a job page its host\'s robots.txt disallows is noted robots_disallow, never recorded as a closed job', async () => {
  const r = await run(site({ 'brightloop.io/careers': '<ul><li><a href="https://jobs.brightloop.io/private/ae">Account Executive - London</a></li></ul>', 'jobs.brightloop.io/private/ae': JOB }, [], {
    'jobs.brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private' },
  }))
  assert.deepEqual(r.items, []); assert.equal(r.notes.robots_disallow, 1, JSON.stringify(r.notes))
})

// ---- Hermes-PC review at 41a445fa ----
test('review (Hermes-PC 3 at 41a445fa): a job its host\'s robots.txt disallows is unverified (a partial read, noted unreachable), never a closed job (a healthy empty)', async () => {
  const asked: string[] = []
  const r = await run(site({ 'brightloop.io/careers': '<ul><li><a href="https://jobs.brightloop.io/private/ae">Account Executive - London</a></li></ul>', 'jobs.brightloop.io/private/ae': JOB }, asked, {
    'jobs.brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private' },
  }))
  assert.deepEqual(r.items, [])
  assert.deepEqual(r.notes, { robots_disallow: 1, unreachable: 1 }, 'job_unverified (403) says nothing about hiring; job_closed (404) would leave no unreachable note')
  assert.ok(!asked.includes('https://jobs.brightloop.io/private/ae'), 'the disallowed job page was never requested')
})

test('review (Hermes-PC 4 at 41a445fa): a robots.txt cut at the byte cap is unreachable: no request to that host, and the read is noted unreachable', async () => {
  // the job's host: a truncated robots.txt whose visible part would allow /careers/ae. Taken as complete, the job would be fetched and become evidence.
  const asked: string[] = []
  const r = await run(site({ 'brightloop.io/careers': '<ul><li><a href="https://jobs.brightloop.io/careers/ae">Account Executive - London</a></li></ul>', 'jobs.brightloop.io/careers/ae': JOB }, asked, {
    'jobs.brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private', truncated: true },
  }))
  assert.deepEqual(r.items, []); assert.equal(r.notes.unreachable, 1, JSON.stringify(r.notes))
  assert.deepEqual(asked.filter(u => new URL(u).hostname === 'jobs.brightloop.io'), ['https://jobs.brightloop.io/robots.txt'], 'nothing but the robots.txt itself is requested from that host')
  // the site's own robots.txt cut at the cap: nothing on the site is read, and the read is partial
  const own: string[] = []
  const r2 = await run(site(OPEN, own, { 'brightloop.io/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private', truncated: true } }))
  assert.deepEqual(r2.items, []); assert.equal(r2.notes.unreachable, 1, JSON.stringify(r2.notes))
  assert.deepEqual(own, ['https://brightloop.io/robots.txt'], 'nothing but the robots.txt itself is requested from the site')
})
