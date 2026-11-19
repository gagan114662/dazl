// #1036 4b: a lead whose evidence page links no company site gets the company's own host from a web search; the homepage name check and
// the place check still decide. Synthetic pages and a stubbed TinyFish answer: no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { companyHostsFromSearch, crawlJob, hostNamesFor, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { siteFinderFor } from '../lib/scan/runner.ts'
import { SITE_SEARCHES_PER_SCAN, BUDGET_EXCLUDED_PATHS } from '../lib/scan/run-budget.ts'
import { estimateRun } from '../lib/scan/price-estimate.ts'

const hits = (...urls: string[]) => urls.map(url => ({ url }))

// ---- which hosts can be the company's own ----
test('companyHostsFromSearch: the exact name, the name with one generic affix or a place word, the name without its trailing type word', () => {
  assert.deepEqual(companyHostsFromSearch('Moss', hits('https://www.getmoss.com/en-de/', 'https://www.linkedin.com/company/getmoss', 'https://finovate.com/moss-berlin', 'https://example.org/moss-review')), ['getmoss.com'])
  assert.deepEqual(companyHostsFromSearch('TDot Dental', hits('https://www.instagram.com/tdotdental/', 'https://tdotdental.ca/', 'https://www.yelp.ca/biz/tdot-dental', 'https://tdotdental.ca/about')), ['tdotdental.ca'])
  assert.deepEqual(companyHostsFromSearch('Queen Street Dental Centre', hits('https://queenstreetdentalcentre.ca/', 'https://queenstreetdental.ca/', 'https://www.zocdoc.com/x')), ['queenstreetdentalcentre.ca', 'queenstreetdental.ca'])
  assert.deepEqual(companyHostsFromSearch('Harbor Dental', hits('https://harbordentalgroup.com/', 'https://harbordentalaustin.com/', 'https://austinharbordental.com/'), 3, ['Austin, Texas']), ['harbordentalgroup.com', 'harbordentalaustin.com', 'austinharbordental.com'])
  assert.deepEqual(companyHostsFromSearch('Harbor Dental', hits('https://harbordentalaustin.com/')), [], 'a place word only counts when it is the lead\'s place')
  assert.deepEqual(companyHostsFromSearch('Acme Dental', hits('https://acme-dental.com/')), ['acme-dental.com'], 'a hyphenated own site')
  assert.deepEqual(companyHostsFromSearch('Müller Bäckerei', hits('https://muellerbaeckerei.de/', 'https://mullerbackerei.de/')), ['muellerbaeckerei.de', 'mullerbackerei.de'])
  assert.deepEqual(companyHostsFromSearch('Acme Dental', hits('https://acmedental.com./')), ['acmedental.com'], 'a trailing dot')
  assert.deepEqual(companyHostsFromSearch('Apparate', hits('https://www.apparate.com.au/blog/x')), ['apparate.com.au'])
  assert.deepEqual(companyHostsFromSearch('Integral', hits('https://group.integral.de/karriere')), ['integral.de'], 'the registrable host is returned, not a subdomain')
  assert.deepEqual(companyHostsFromSearch('Bluebonnet Realty', hits('https://a.com', 'https://b.com', 'https://bluebonnetrealty.com/x', 'https://bluebonnetrealty.net/', 'https://bluebonnetrealty.org/'), 2), ['bluebonnetrealty.com', 'bluebonnetrealty.net'], 'at most max hosts')
  assert.deepEqual(hostNamesFor('Queen Street Dental Centre'), ['queenstreetdentalcentre', 'queenstreetdental'])
})

test('companyHostsFromSearch (council review): ANOTHER business whose name contains the company\'s is never offered; neither is a fragment, a platform host or a non-host', () => {
  // a different business with the name inside its own would pass the homepage substring check: it must not get that far
  assert.deepEqual(companyHostsFromSearch('Harbor Dental', hits('https://lakeharbordental.example/', 'https://harbordentalsupplyco.com/', 'https://newharbordentalcare.com/'), 3, ['Austin']), [])
  assert.deepEqual(companyHostsFromSearch('The Dental Clinic', hits('https://smithdentalclinic.com/')), [])
  assert.deepEqual(companyHostsFromSearch('Moss', hits('https://mossgreenlandscaping.com/', 'https://mossinc.com/')), ['mossinc.com'], '"inc" is a generic affix; "greenlandscaping" is another business')
  // a fragment of the name is not the company
  assert.deepEqual(companyHostsFromSearch('Harbor Dental', hits('https://dental.com/', 'https://harbor.com/', 'https://dental.co.uk/')), [])
  assert.deepEqual(companyHostsFromSearch('Smith & Co', hits('https://smith.io/', 'https://smithandco.com/')), ['smithandco.com'])
  // platform hosts: a careers board, a site builder, a blog host - the page may name the company, the host is the platform's
  assert.deepEqual(companyHostsFromSearch('Harbor Dental', hits('https://harbordental.bamboohr.com/careers', 'https://harbordental.jobs.personio.de/', 'https://harbordental.wixsite.com/home', 'https://harbordental.wordpress.com/', 'https://harbordental.medium.com/', 'https://harbordental.business.site/')), [])
  assert.deepEqual(companyHostsFromSearch('Harbor Foods', hits('https://booking.harborfoods.example/', 'https://x.harborfoods.example/')), ['harborfoods.example'], 'a listed word is refused only as the registrable name')
  // not a company host at all
  assert.deepEqual(companyHostsFromSearch('Stateline Systems', hits('https://statelinesystems.gov/', 'https://statelinesystems.edu/', 'https://statelinesystems.gov.uk/')), [])
  assert.deepEqual(companyHostsFromSearch('Harbor Dental', hits('javascript:alert(1)', 'ftp://harbordental.com', 'not a url', 'https://203.0.113.9/', 'https://harbordental.example:8443/x')), ['harbordental.example'])
  assert.deepEqual(companyHostsFromSearch('Ace', hits('https://ace.com')), [], 'a name under 4 letters cannot be told from another company\'s host')
  assert.deepEqual(hostNamesFor('IBM'), []); assert.deepEqual(hostNamesFor('3M Co'), [])
})

// ---- crawlJob ----
function seed() {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, signal TEXT, evidence_excerpt TEXT)')
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Harbor Dental','https://www.instagram.com/p/abc/',NULL,90,80,NULL,'Harbor Dental opened a new office in Austin','Harbor Dental opened a new office in Austin')").run()
  db.exec("CREATE TABLE IF NOT EXISTS scan_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 't1', icp TEXT)")
  db.prepare('INSERT INTO scan_jobs (id, icp) VALUES (?, ?)').run('j1', JSON.stringify({ where: ['Austin, Texas'], who: ['Owner'] }))
  return db
}
const HOME = (name: string, place = '120 Congress Ave, Austin, TX 78701') => `<html><body>${name}, a family practice at ${place} <a href="/contact-us">c</a></body></html>`
// serves the given hosts (each with its own homepage text) and records every host + path asked
const siteGet = (homes: Record<string, string>, seen: string[] = []): Get => async url => {
  const u = new URL(url); seen.push(u.hostname + u.pathname)
  const home = homes[u.hostname]
  if (home === undefined) return { status: 404, body: '', finalUrl: url }
  if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
  if (u.pathname === '/') return { status: 200, body: home, finalUrl: url }
  if (u.pathname === '/contact-us') return { status: 200, body: `<html><body>Email: hello@${u.hostname}</body></html>`, finalUrl: url }
  return { status: 404, body: '', finalUrl: url }
}
const domains = (db: Database.Database) => (db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'domain'").all() as { value: string }[]).map(r => r.value)

test('crawlJob: no site linked -> the searched host is read and recorded with the weakest basis (name_probe); the contact on it is stored', async () => {
  const db = seed(); const asked: string[] = []
  await crawlJob(db, 't1', 'j1', { get: siteGet({ 'harbordental.example': HOME('Harbor Dental') }), gapMs: 0, env: {}, findSites: async (company, where) => { asked.push(`${company}|${where.join(',')}`); return ['harbordental.example'] } })
  assert.deepEqual(asked, ['Harbor Dental|Austin, Texas'])
  assert.deepEqual(domains(db), ['harbordental.example|name_probe'])
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string }).d, 'harbordental.example')
  assert.ok((db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'email'").all() as { value: string }[]).some(r => r.value === 'hello@harbordental.example'))
})

test('crawlJob: a searched host that is another company (name absent) or the right name in another place is refused; without findSites nothing changes', async () => {
  const db = seed()
  await crawlJob(db, 't1', 'j1', { get: siteGet({ 'zenith.example': HOME('Zenith Plumbing') }), gapMs: 0, env: {}, findSites: async () => ['zenith.example'] })
  assert.deepEqual(domains(db), [], 'the homepage does not name the company')
  const db2 = seed()
  await crawlJob(db2, 't1', 'j1', { get: siteGet({ 'harbordental.example': HOME('Harbor Dental', '9 Main St, Portland, ME 04101') }), gapMs: 0, env: {}, findSites: async () => ['harbordental.example'] })
  assert.deepEqual(domains(db2), [], 'the same name in another state is not this lead\'s company')
  const db3 = seed()
  await crawlJob(db3, 't1', 'j1', { get: siteGet({ 'harbordental.example': HOME('Harbor Dental') }), gapMs: 0, env: {} })
  assert.deepEqual(domains(db3), [], 'no findSites: only the name guesses, none of which is this host')
})

test('crawlJob: a findSites that throws falls back to the name guesses - the guessed domain is still read and recorded', async () => {
  const db = seed()
  await crawlJob(db, 't1', 'j1', { get: siteGet({ 'harbordental.com': HOME('Harbor Dental') }), gapMs: 0, env: {}, findSites: async () => { throw new Error('search down') } })
  assert.deepEqual(domains(db), ['harbordental.com|name_probe'], 'the crawl went on to the guessed domain')
})

test('crawlJob: the searched host is tried BEFORE the name guesses, and when it is accepted the guesses are not read', async () => {
  const db = seed(); const seen: string[] = []
  await crawlJob(db, 't1', 'j1', { get: siteGet({ 'harbordental.example': HOME('Harbor Dental'), 'harbordental.com': HOME('Harbor Dental') }, seen), gapMs: 0, env: {}, findSites: async () => ['harbordental.example'] })
  assert.deepEqual(domains(db), ['harbordental.example|name_probe'])
  assert.ok(!seen.some(h => h.startsWith('harbordental.com/')), `the guessed domain was not read: ${seen.join(', ')}`)
})

test('crawlJob: a lead whose source page refused us never has that host read again, even when the search names it', async () => {
  const db = seed(); const seen: string[] = []; const asked: string[] = []
  db.prepare("UPDATE leads SET review_reason = 'blocked_by_site', source_url = 'https://harbordental.example/news/opening' WHERE id = 'l1'").run()
  await crawlJob(db, 't1', 'j1', { get: siteGet({ 'harbordental.example': HOME('Harbor Dental'), 'shop.harbordental.example': HOME('Harbor Dental') }, seen), gapMs: 0, env: {}, findSites: async c => { asked.push(c); return ['harbordental.example', 'shop.harbordental.example'] } })
  assert.equal(asked.length, 1, 'the search ran for the blocked lead')
  assert.ok(!seen.some(h => h.startsWith('harbordental.example/') || h.startsWith('shop.harbordental.example/')), `neither the refusing host nor a host under it was fetched: ${seen.join(', ')}`)
  assert.deepEqual(domains(db), [])
  assert.ok((db.prepare('SELECT status FROM connector_audit').all() as { status: string }[]).some(a => a.status.startsWith('skipped_site')), 'the skip is audited')
})

test('crawlJob: an aborted crawl asks no search', async () => {
  const db = seed(); let n = 0
  await crawlJob(db, 't1', 'j1', { get: siteGet({}), gapMs: 0, env: {}, signal: AbortSignal.abort(), findSites: async () => { n++; return ['harbordental.example'] } })
  assert.equal(n, 0)
})

// ---- the runner's search step (siteFinderFor): the real tfSearch with a stubbed TinyFish answer ----
const tfAnswer = (urls: string[]) => new Response(JSON.stringify({ results: urls.map(url => ({ url, title: 't', snippet: 's' })) }), { status: 200, headers: { 'content-type': 'application/json' } })
const withKey = async (f: () => Promise<void>) => { const had = process.env.TINYFISH_API_KEY; process.env.TINYFISH_API_KEY = 'test-key-not-real'; try { await f() } finally { if (had === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = had } }
type FinderJob = Parameters<typeof siteFinderFor>[1]
// a live scan of tenant-A, as the post-finish step sees it (this attempt, not failed or deleted)
function scan(over: Record<string, unknown> = {}) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const id = createJob(db, 'tenant-A', { business_name: 'Seller', industry: 'x', location: 'x' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(id)   // alive: 'running' or 'done' on this attempt
  const attempts = (db.prepare('SELECT attempts FROM scan_jobs WHERE id = ?').get(id) as { attempts: number }).attempts
  return { db, job: { id, user_id: 'tenant-A', attempts, ...over } as unknown as FinderJob }
}
const searchesToday = (db: Database.Database) => (db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM tinyfish_usage WHERE tenant_id = 'tenant-A' AND kind = 'search'").get() as { n: number }).n
const audits = (db: Database.Database) => (db.prepare("SELECT lookup, status, results FROM connector_audit WHERE connector = 'sitecrawl' ORDER BY rowid").all() as { lookup: string; status: string; results: number }[])

test('siteFinderFor: off without TinyFish; with it, one search per COMPANY "<company> <place> official website", own-site hosts only, counted for the tenant and recorded', async () => {
  const had = process.env.TINYFISH_API_KEY; delete process.env.TINYFISH_API_KEY
  try { const { db, job } = scan(); assert.equal(siteFinderFor(db, job, {}), undefined, 'no TinyFish key: the crawl guesses from the name as before') } finally { if (had !== undefined) process.env.TINYFISH_API_KEY = had }
  await withKey(async () => {
    const { db, job } = scan(); const asked: string[] = []
    const fetchImpl = (async (u: string | URL) => { asked.push(new URL(String(u)).searchParams.get('query') ?? ''); return tfAnswer(['https://www.instagram.com/tdotdental/', 'https://tdotdental.ca/', 'https://www.yelp.ca/biz/tdot-dental']) }) as typeof fetch
    const find = siteFinderFor(db, job, { fetchImpl })!
    assert.deepEqual(await find('TDot Dental', ['Toronto, Ontario']), ['tdotdental.ca'])
    assert.deepEqual(asked, ['TDot Dental Toronto, Ontario official website'])
    assert.deepEqual(await find('TDot Dental', ['Toronto, Ontario']), ['tdotdental.ca']); assert.equal(asked.length, 1, 'a second lead on the same company shares the answer: no second search')
    assert.deepEqual(await find('T-Dot Dental', []), ['tdotdental.ca']); assert.equal(asked.length, 1, 'the same company written differently is the same company')
    await find('Harbor Dental', []); assert.equal(asked[1], 'Harbor Dental official website', 'no place known: the query has none')
    assert.deepEqual(await find('IBM', ['Austin']), []); assert.equal(asked.length, 2, 'a name too short to match a host spends no search')
    assert.equal(searchesToday(db), 2, 'two searches counted against the tenant\'s day')
    assert.deepEqual(audits(db), [{ lookup: 'TDot Dental', status: 'site_search_ok', results: 1 }, { lookup: 'Harbor Dental', status: 'site_search_ok', results: 0 }])
  })
})

test('siteFinderFor: at most SITE_SEARCHES_PER_SCAN searches per scan; a refused key stops further searches and is recorded; nothing after the deadline', async () => {
  await withKey(async () => {
    const { db, job } = scan(); let n = 0
    const find = siteFinderFor(db, job, { fetchImpl: (async () => { n++; return tfAnswer(['https://harbordental.example/']) }) as typeof fetch })!
    for (let i = 0; i < SITE_SEARCHES_PER_SCAN + 3; i++) await find(`Harbor Dental ${'abcdefghijkl'[i]}`, ['Austin'])   // nine different companies
    assert.equal(n, SITE_SEARCHES_PER_SCAN, 'the cap holds'); assert.equal(searchesToday(db), SITE_SEARCHES_PER_SCAN)
    const b = scan(); let m = 0
    const refused = siteFinderFor(b.db, b.job, { fetchImpl: (async () => { m++; return new Response('{}', { status: 401 }) }) as typeof fetch })!
    assert.deepEqual(await refused('Harbor Dental', ['Austin']), [])
    assert.deepEqual(await refused('Other Dental', ['Austin']), [])
    assert.equal(m, 1, 'a rejected key is not asked again in this scan')
    assert.equal(audits(b.db).length, 1); assert.match(audits(b.db)[0].status, /^site_search_(auth|unavailable|quota)/, 'the refusal is on record, not a silent "no results"')
    const aborted = siteFinderFor(b.db, b.job, { fetchImpl: (async () => { m++; return tfAnswer([]) }) as typeof fetch }, AbortSignal.abort())!
    assert.deepEqual(await aborted('Harbor Dental', ['Austin']), []); assert.equal(m, 1, 'nothing is sent after the post-finish deadline')
  })
})

test('siteFinderFor (council review): a scan that was cancelled, deleted or taken over by a newer attempt sends no search', async () => {
  await withKey(async () => {
    for (const [why, change] of [['failed / cancelled', "UPDATE scan_jobs SET status = 'failed'"], ['taken over by a newer attempt', 'UPDATE scan_jobs SET attempts = attempts + 1'], ['deleted', 'DELETE FROM scan_jobs']] as const) {
      const { db, job } = scan(); let n = 0
      const find = siteFinderFor(db, job, { fetchImpl: (async () => { n++; return tfAnswer(['https://harbordental.example/']) }) as typeof fetch })!
      db.prepare(change).run()
      assert.deepEqual(await find('Harbor Dental', ['Austin']), [], why); assert.equal(n, 0, why); assert.equal(searchesToday(db), 0, why)
    }
  })
})

test('siteFinderFor policy: never on a free-trial scan, a first play, a run with paid steps off, a watch\'s run or a monitor\'s run', async () => {
  await withKey(async () => {
    const fetchImpl = (async () => { throw new Error('must not be called') }) as typeof fetch
    const plain = scan(); assert.equal(typeof siteFinderFor(plain.db, plain.job, { fetchImpl }), 'function', 'an ordinary scan gets it')
    assert.equal(siteFinderFor(plain.db, plain.job, { fetchImpl, first5: true }), undefined, 'first play')
    assert.equal(siteFinderFor(plain.db, plain.job, { fetchImpl, paidFallback: false }), undefined, 'paid steps off')
    const trial = scan({ funded_by: 'trial' }); assert.equal(siteFinderFor(trial.db, trial.job, { fetchImpl }), undefined, 'free trial')
    const watch = scan({ watch_id: 'w1' }); assert.equal(siteFinderFor(watch.db, watch.job, { fetchImpl }), undefined, 'a watch\'s scheduled run')
    const mon = scan()
    mon.db.prepare("INSERT INTO monitors (id, user_id, query, interval_hours) VALUES ('m1', 'tenant-A', 'dental offices opening', 168)").run()
    mon.db.prepare("INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, missed_runs) VALUES ('r1', 'm1', ?, 1, 0)").run(mon.job.id)
    assert.equal(siteFinderFor(mon.db, mon.job, { fetchImpl }), undefined, 'a monitor\'s run')
  })
})

test('the post-finish step hands the search to the crawl, and the estimate and the disclosure state it under the runner\'s conditions', () => {
  // Keep the finder and its crawl handoff tied to the same job and deadline. Other crawl options
  // (such as the strict reader and buyer callback) must not make the finder optional in a new way.
  const src = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
  const postFinish = src.slice(src.indexOf('export async function runPostFinishBounded('))
  const finder = /const findSites = siteFinderFor\(db, job, deps, postCtrl\.signal\)/.exec(postFinish)
  assert.ok(finder, 'build the exact job finder with the post-finish abort signal')
  const crawl = /await crawlJob\(db, job\.user_id, job\.id, \{([\s\S]*?)\}\)[ \t]*(?:;[^\n]*)?\n/.exec(postFinish.slice(finder.index))
  assert.ok(crawl, 'the same tenant and job are passed to crawlJob')
  assert.match(crawl[1], /\bsignal:\s*postCtrl\.signal\b/, 'the crawl uses the same deadline')
  assert.match(crawl[1], /\.\.\.\(findSites\s*\?\s*\{\s*findSites\s*\}\s*:\s*\{\s*\}\)/, 'pass through the specific finder when available')
  assert.match(crawl[1], /\.\.\.\(qaClaudeOnlyJob\(job\.run_budget\)\s*\?\s*\{\s*nativeOnly:\s*true\s*\}\s*:\s*\{\s*\}\)/, 'only strict jobs require the native reader')
  const row = (o: Record<string, unknown>, env: Record<string, string> = {}) => estimateRun({ budget: null, payer: 'you', env, ...o } as Parameters<typeof estimateRun>[0]).rows.find(r => r.id === 'tinyfish_search')
  const on = row({}), off = row({}, { SITECRAWL_ENABLED: '0' }), noPaid = row({ budget: { paid_fallback: false } }), trial = row({ payer: 'trial' })
  assert.ok(on && off && noPaid && trial, 'the search row exists in all four')
  assert.equal(on.units.max - off.units.max, SITE_SEARCHES_PER_SCAN, 'the estimate counts the company-website searches')
  assert.match(on.note, /at most 6 company-website searches/)
  for (const r of [off, noPaid, trial]) assert.doesNotMatch(r.note, /company-website/)
  const first = estimateRun({ budget: { first5: true }, payer: 'you', env: {} } as Parameters<typeof estimateRun>[0])
  assert.ok(!first.rows.some(r => /company-website/.test(r.note ?? '')), 'a first play states none')
  assert.ok(BUDGET_EXCLUDED_PATHS.some(l => /at most 6 more searches \(counted on top of the per-scan searches above/.test(l) && /never a free-trial scan, a first play, a run with paid_fallback=false, or a watch's or monitor's scheduled run/.test(l)))
})
