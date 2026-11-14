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
