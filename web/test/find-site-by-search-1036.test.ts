// #1036 4b: a lead whose evidence page links no company site gets the company's own host from a web search; the homepage name check still
// decides. Synthetic pages and a stubbed search: no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { companyHostsFromSearch, crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const hits = (...urls: string[]) => urls.map(url => ({ url }))

test('companyHostsFromSearch: the company\'s own host only; social, job boards, directories and news never; a result that merely mentions it never', () => {
  assert.deepEqual(companyHostsFromSearch('Moss', hits('https://www.getmoss.com/en-de/', 'https://www.linkedin.com/company/getmoss', 'https://finovate.com/moss-berlin', 'https://example.org/moss-review')), ['getmoss.com'])
  assert.deepEqual(companyHostsFromSearch('TDot Dental', hits('https://www.instagram.com/tdotdental/', 'https://tdotdental.ca/', 'https://www.yelp.ca/biz/tdot-dental', 'https://tdotdental.ca/about')), ['tdotdental.ca'])
  assert.deepEqual(companyHostsFromSearch('Queen Street Dental Centre', hits('https://queenstreetdentalcentre.ca/', 'https://queenstreetdental.ca/', 'https://www.zocdoc.com/x')), ['queenstreetdentalcentre.ca', 'queenstreetdental.ca'])
  assert.deepEqual(companyHostsFromSearch('Ace', hits('https://ace.com')), [], 'a company name shorter than 4 letters is not searched for a host')
  assert.deepEqual(companyHostsFromSearch('Bluebonnet Realty', hits('javascript:alert(1)', 'ftp://bluebonnetrealty.com', 'not a url', 'https://bluebonnetrealty.com/')), ['bluebonnetrealty.com'])
  assert.deepEqual(companyHostsFromSearch('Bluebonnet Realty', hits('https://a.com', 'https://b.com', 'https://bluebonnetrealty.com/x', 'https://bluebonnetrealty.net/', 'https://bluebonnetrealty.org/', 'https://bluebonnetrealty.co/', 'https://bluebonnetrealty.io/'), 2), ['bluebonnetrealty.com', 'bluebonnetrealty.net'], 'at most max hosts')
  assert.deepEqual(companyHostsFromSearch('Stateline Systems', hits('https://stateline.gov/', 'https://stateline.edu/')), [])
})

function seed() {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, signal TEXT, evidence_excerpt TEXT)')
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Harbor Dental','https://www.instagram.com/p/abc/',NULL,90,80,NULL,'Harbor Dental opened a new office in Austin','Harbor Dental opened a new office in Austin')").run()
  db.exec('CREATE TABLE IF NOT EXISTS scan_jobs (id TEXT PRIMARY KEY, icp TEXT)')
  db.prepare('INSERT INTO scan_jobs (id, icp) VALUES (?, ?)').run('j1', JSON.stringify({ where: ['Austin, Texas'], who: ['Owner'] }))
  return db
}
const pages: Record<string, string> = { '/robots.txt': '', '/': '<html><body>Harbor Dental, a family practice at 120 Congress Ave, Austin, TX 78701 <a href="/contact-us">c</a></body></html>', '/contact-us': '<html><body>Email: hello@harbordental.example</body></html>' }
const get: Get = async url => { const u = new URL(url); const b = pages[u.pathname]; return b === undefined || u.hostname !== 'harbordental.example' ? { status: 404, body: '', finalUrl: url } : { status: 200, body: b, finalUrl: url } }

test('crawlJob: no site linked -> the searched host is read, recorded with the weakest basis (name_probe), and the guessed domains are only the fallback', async () => {
  const db = seed(); const asked: string[] = []
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, findSites: async (company, where) => { asked.push(`${company}|${where.join(',')}`); return ['harbordental.example'] } })
  assert.deepEqual(asked, ['Harbor Dental|Austin, Texas'])
  assert.deepEqual(db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'domain'").all(), [{ value: 'harbordental.example|name_probe' }])
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string }).d, 'harbordental.example')
  assert.ok((db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'email'").all() as { value: string }[]).some(r => r.value === 'hello@harbordental.example'))
})

test('crawlJob: a searched host whose homepage does NOT name the company is refused (no wrong-company contact); without findSites nothing changes', async () => {
  const db = seed()
  const other: Get = async url => { const u = new URL(url); return u.pathname === '/robots.txt' ? { status: 200, body: '', finalUrl: url } : u.pathname === '/' ? { status: 200, body: '<html><body>Zenith Plumbing of Dallas</body></html>', finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 't1', 'j1', { get: other, gapMs: 0, env: {}, findSites: async () => ['harbor-plumbing.example'] })
  assert.deepEqual(db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'domain'").all(), [])
  const db2 = seed()
  await crawlJob(db2, 't1', 'j1', { get, gapMs: 0, env: {} })
  assert.deepEqual(db2.prepare("SELECT value FROM lead_enrichments WHERE kind = 'domain'").all(), [], 'no findSites: only the name guesses, none of which is this host')
})

test('crawlJob: a findSites that throws or answers nothing falls back to the name guesses and never breaks the crawl', async () => {
  const db = seed()
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, findSites: async () => { throw new Error('search down') } })
  assert.deepEqual(db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'domain'").all(), [])
})

// The runner's search step itself (siteFinderFor): the real tfSearch with a stubbed TinyFish answer; no network.
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { siteFinderFor } from '../lib/scan/runner.ts'
import { SITE_SEARCHES_PER_SCAN } from '../lib/scan/run-budget.ts'

const tfAnswer = (urls: string[]) => new Response(JSON.stringify({ results: urls.map(url => ({ url, title: 't', snippet: 's' })) }), { status: 200, headers: { 'content-type': 'application/json' } })
const withKey = async (f: () => Promise<void>) => { const had = process.env.TINYFISH_API_KEY; process.env.TINYFISH_API_KEY = 'test-key-not-real'; try { await f() } finally { if (had === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = had } }
const JOB = { id: 'j'.repeat(24), user_id: 'tenant-A' } as Parameters<typeof siteFinderFor>[1]

test('siteFinderFor: off without TinyFish; with it, one search per lead "<company> <place> official website", only own-site hosts returned, and the tenant\'s daily count moves', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const had = process.env.TINYFISH_API_KEY; delete process.env.TINYFISH_API_KEY
  try { assert.equal(siteFinderFor(db, JOB, {}), undefined, 'no TinyFish key: the crawl guesses from the name as before') } finally { if (had !== undefined) process.env.TINYFISH_API_KEY = had }
  await withKey(async () => {
    const asked: string[] = []
    const fetchImpl = (async (u: string | URL) => { asked.push(new URL(String(u)).searchParams.get('query') ?? ''); return tfAnswer(['https://www.instagram.com/tdotdental/', 'https://tdotdental.ca/', 'https://www.yelp.ca/biz/tdot-dental']) }) as typeof fetch
    const find = siteFinderFor(db, JOB, { fetchImpl })!
    assert.deepEqual(await find('TDot Dental', ['Toronto, Ontario']), ['tdotdental.ca'])
    assert.deepEqual(asked, ['TDot Dental Toronto, Ontario official website'])
    assert.deepEqual(await find('TDot Dental', []), ['tdotdental.ca']); assert.equal(asked[1], 'TDot Dental official website')
  })
})

test('siteFinderFor: at most SITE_SEARCHES_PER_SCAN searches per scan; a failed search answers nothing; a refused key stops further searches', async () => {
  await withKey(async () => {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    let n = 0
    const find = siteFinderFor(db, JOB, { fetchImpl: (async () => { n++; return tfAnswer(['https://harbordental.example/']) }) as typeof fetch })!
    for (let i = 0; i < SITE_SEARCHES_PER_SCAN + 3; i++) await find('Harbor Dental', ['Austin'])
    assert.equal(n, SITE_SEARCHES_PER_SCAN, 'the cap holds')
    const db2 = new Database(':memory:'); migrateAllSqlite(db2)
    let m = 0
    const refused = siteFinderFor(db2, JOB, { fetchImpl: (async () => { m++; return new Response('{}', { status: 401 }) }) as typeof fetch })!
    assert.deepEqual(await refused('Harbor Dental', ['Austin']), [])
    assert.deepEqual(await refused('Other Dental', ['Austin']), [])
    assert.equal(m, 1, 'a rejected key is not asked again in this scan')
    const aborted = siteFinderFor(db2, JOB, { fetchImpl: (async () => { m++; return tfAnswer([]) }) as typeof fetch }, AbortSignal.abort())!
    assert.deepEqual(await aborted('Harbor Dental', ['Austin']), []); assert.equal(m, 1, 'nothing is sent after the post-finish deadline')
  })
})

test('siteFinderFor policy: never on a first play or a run with paid steps off (those scans keep the name-guessed domains); the estimate states the searches', async () => {
  await withKey(async () => {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    assert.equal(siteFinderFor(db, JOB, { first5: true }), undefined)
    assert.equal(siteFinderFor(db, JOB, { paidFallback: false }), undefined)
    assert.equal(typeof siteFinderFor(db, JOB, {}), 'function')
  })
  const { estimateRun } = await import('../lib/scan/price-estimate.ts')
  const row = (o: Record<string, unknown>, env: Record<string, string> = {}) => estimateRun({ budget: null, payer: 'you', env, ...o } as Parameters<typeof estimateRun>[0]).rows.find(r => r.id === 'tinyfish_search')
  const on = row({}), off = row({}, { SITECRAWL_ENABLED: '0' }), noPaid = row({ budget: { paid_fallback: false } }), trial = row({ payer: 'trial' })
  assert.equal(on!.units.max - off!.units.max, SITE_SEARCHES_PER_SCAN, 'the estimate counts the company-website searches')
  assert.match(on!.note, /at most 6 company-website searches/)
  assert.doesNotMatch(off!.note, /company-website/); assert.doesNotMatch(noPaid?.note ?? '', /company-website/); assert.doesNotMatch(trial?.note ?? '', /company-website/)
})
