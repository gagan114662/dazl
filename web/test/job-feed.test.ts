import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { createHiringFeedIntake, hiringFeedStatus, JobFeedError, matchRoles, parseFeedItems, parseRoleWords, retryHiringFeedContacts } from '../lib/scan/job-feed.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'

const item = (title: string, guid: string, extra = '') => `<item><title>${title}</title><pubDate>Fri, 23 Oct 2026 09:48:36 +0000</pubDate><guid>${guid}</guid><description>&lt;p&gt;&lt;strong&gt;URL:&lt;/strong&gt; &lt;a href="https://acmeco.example"&gt;x&lt;/a&gt;&lt;/p&gt;${extra}</description></item>`
const XML = `<rss><channel>${[
  item('Acmeco: Sales Development Representative', 'https://weworkremotely.com/remote-jobs/acmeco-sdr'),
  item('Bigvendor: Account Executive, Commercial', 'https://weworkremotely.com/remote-jobs/bigvendor-ae'),
  item('Elsewhere: Sales Development Representative', 'https://evil.example/remote-jobs/x'),
  item('NoColon Sales Development Representative', 'https://weworkremotely.com/remote-jobs/nocolon'),
  item('Plain: Head of Design', 'https://weworkremotely.com/remote-jobs/plain-design'),
].join('')}</channel></rss>`

test('feed parsing keeps only company: role items on the pinned posting host and reads the stated site', () => {
  const items = parseFeedItems(XML)
  assert.deepEqual(items.map(i => [i.company, i.role]), [['Acmeco', 'Sales Development Representative'], ['Bigvendor', 'Account Executive, Commercial'], ['Plain', 'Head of Design']])
  assert.equal(items[0].site, 'https://acmeco.example')
  assert.equal(items[0].date, '2026-10-23')
  assert.deepEqual(matchRoles(items, ['sales development']).map(i => i.company), ['Acmeco'])
  assert.throws(() => parseRoleWords(''), JobFeedError)
  assert.throws(() => parseRoleWords('a,b'), JobFeedError)
  assert.deepEqual(parseRoleWords(' Account Executive, account executive ,SDR role'), ['account executive', 'sdr role'])
})

test('intake saves only postings whose page shows the posting line, as ungraded needs-review hiring signals, then reads the company site contact', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
  const pages: Record<string, string> = {
    '/remote-jobs/acmeco-sdr': '<html><body>Acmeco is hiring <a href="https://acmeco.example/">Acmeco</a></body></html>',
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': '<html><body>Acmeco <a href="/contact">Contact</a></body></html>',
    '/contact': '<html><body><a href="mailto:hello@acmeco.example">hello</a> <a href="mailto:press@acmeco.example">press</a></body></html>',
  }
  const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  const shown: Record<string, string> = { 'https://weworkremotely.com/remote-jobs/acmeco-sdr': 'Remote Sales Development Representative at Acmeco Find Jobs' }
  const r = await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sales development, account executive', {
    fetchFeed: async () => XML, get, gapMs: 0, env: {}, now: 1800000000,
    fetchPage: async u => shown[u] ? { title: 'Remote Sales Development Representative at Acmeco', text: shown[u], retrievedAt: 1800000000 } : { title: 'Bigvendor', text: 'Some other text', retrievedAt: 1800000000 },
  })
  assert.equal(r.leads.length, 1)
  await r.crawl
  assert.equal(r.feed_items, 3); assert.equal(r.matched, 2); assert.equal(r.leads.length, 1); assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].company, 'Bigvendor')
  const l = db.prepare('SELECT company,signal,source_url,evidence_excerpt,confidence,review_reason,source_kind,date_status,event_date,human_confirmed_at,fit FROM leads').get() as Record<string, unknown>
  assert.equal(l.company, 'Acmeco'); assert.equal(l.evidence_excerpt, 'Sales Development Representative at Acmeco')
  assert.match(String(l.signal), /hiring signal only: not buying intent, fit or current need/)
  assert.equal(l.confidence, null); assert.equal(l.review_reason, 'source_review_required'); assert.equal(l.source_kind, 'hiring_feed')
  assert.equal(l.date_status, 'unverified'); assert.equal(l.human_confirmed_at, null); assert.equal(l.fit, null)
  const sr = db.prepare('SELECT quote_match,company_named,contact_match FROM source_reviews').get()
  assert.deepEqual(sr, { quote_match: 1, company_named: 1, contact_match: 0 })
  assert.deepEqual(db.prepare('SELECT status,verified,needs_review,candidates FROM scan_jobs').get(), { status: 'done', verified: 0, needs_review: 1, candidates: 1 })
  const emails = db.prepare("SELECT value FROM lead_enrichments WHERE kind='email' ORDER BY value").all()
  assert.deepEqual(emails, [{ value: 'hello@acmeco.example' }, { value: 'press@acmeco.example' }])
  // A second click for the same company saves nothing new.
  const again = await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sales development', { fetchFeed: async () => XML, get, gapMs: 0, env: {}, fetchPage: async () => ({ title: 'Acmeco', text: 'Remote Sales Development Representative at Acmeco', retrievedAt: 1800000000 }) })
  await again.crawl
  assert.equal(again.job_id, null); assert.equal((db.prepare('SELECT count(*) c FROM leads').get() as { c: number }).c, 1)
  // Nothing here confirms the lead: a draft still needs the user's own review.
  const id = (db.prepare('SELECT id FROM leads').get() as { id: string }).id
  assert.throws(() => createDraft(db, 'A', id, 'Seller'), /lead_not_verified/)
})

test('unreadable feed, no match and unshown posting lines save nothing', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
  assert.equal((await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sdr', { fetchFeed: async () => null })).job_id, null)
  assert.equal((await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'zzzz role', { fetchFeed: async () => XML })).job_id, null)
  const r = await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sales development', { fetchFeed: async () => XML, fetchPage: async () => ({ fail: 'blocked' as const }) })
  assert.equal(r.job_id, null); assert.equal(r.skipped.length, 1)
  await assert.rejects(createHiringFeedIntake(db, 'A', 'https://evil.example/x.rss', 'sdr', { fetchFeed: async () => XML }), JobFeedError)
  assert.equal((db.prepare('SELECT count(*) c FROM leads').get() as { c: number }).c, 0)
  assert.equal((db.prepare('SELECT count(*) c FROM scan_jobs').get() as { c: number }).c, 0)
})

const SHOWN = (u: string) => ({ title: 'Remote Sales Development Representative at Acmeco', text: 'Remote Sales Development Representative at Acmeco', retrievedAt: 1800000000, u })
const okPages: Record<string, string> = {
  '/remote-jobs/acmeco-sdr': '<html><body>Acmeco is hiring <a href="https://acmeco.example/">Acmeco</a></body></html>',
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': '<html><body>Acmeco <a href="/contact">Contact</a></body></html>',
  '/contact': '<html><body><a href="mailto:hello@acmeco.example">hello</a></body></html>',
}
const okGet: Get = async url => { const p = okPages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
const mk = () => { const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); return db }
const run = (db: Database.Database, deps: object) => createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sales development', { fetchFeed: async () => XML, fetchPage: async u => SHOWN(u), gapMs: 0, env: {}, ...deps })

test('per-company contact state is recorded: finished with address, and finished with none published is distinct from not finished', async () => {
  const db = mk()
  const r = await run(db, { get: okGet }); await r.crawl
  assert.deepEqual(hiringFeedStatus(db, 'A', r.job_id!).map(x => [x.company, x.state, x.emails, x.site]), [['Acmeco', 'finished', 1, 'acmeco.example']])
  assert.deepEqual(hiringFeedStatus(db, 'B', r.job_id!), [])
  const db2 = mk(); const none: Get = async url => { const p = new URL(url).pathname; const m: Record<string, string> = { ...okPages, '/contact': '<html><body>No address here, use the form.</body></html>' }; return m[p] !== undefined ? { status: 200, body: m[p], finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  const r2 = await run(db2, { get: none }); await r2.crawl
  assert.deepEqual(hiringFeedStatus(db2, 'A', r2.job_id!).map(x => [x.state, x.emails]), [['finished', 0]])
})

test('a read that throws or hits its deadline is marked not finished, and retry reads it again exactly once even when started twice', async () => {
  const db = mk()
  let boom = true
  const flaky: Get = async url => { if (boom) throw new Error('down'); return okGet(url) }
  const r = await run(db, { get: flaky }); await r.crawl
  assert.equal(hiringFeedStatus(db, 'A', r.job_id!)[0].state, 'failed')
  boom = false
  const [a, b] = await Promise.all([retryHiringFeedContacts(db, 'A', r.job_id!, { get: flaky, gapMs: 0, env: {} }), retryHiringFeedContacts(db, 'A', r.job_id!, { get: flaky, gapMs: 0, env: {} })])
  assert.equal(a.retrying + b.retrying, 1)
  await Promise.all([a.crawl, b.crawl])
  assert.deepEqual(hiringFeedStatus(db, 'A', r.job_id!).map(x => [x.state, x.emails]), [['finished', 1]])
  assert.equal((await retryHiringFeedContacts(db, 'A', r.job_id!)).retrying, 0)
  const db2 = mk(); const slow: Get = async url => { await new Promise(res => setTimeout(res, 120)); return okGet(url) }
  const r2 = await run(db2, { get: slow, deadlineMs: 30 }); await r2.crawl
  assert.equal(hiringFeedStatus(db2, 'A', r2.job_id!)[0].state, 'cut_off')
})

test('a stale reading row shows as interrupted, and running the same intake again re-reads it instead of stranding it behind the duplicate skip', async () => {
  const db = mk()
  const r = await run(db, { get: async () => null }); await r.crawl
  db.prepare("UPDATE hiring_feed_crawl SET status = 'reading', started_at = 1000, finished_at = NULL").run()
  assert.equal(hiringFeedStatus(db, 'A', r.job_id!, 1000 + 151)[0].state, 'interrupted')
  assert.equal(hiringFeedStatus(db, 'A', r.job_id!, 1000 + 10)[0].state, 'reading')
  const again = await run(db, { get: okGet }); await again.crawl
  assert.equal(again.job_id, null); assert.match(again.note, /Reading contacts again for 1 saved company/)
  assert.equal((db.prepare('SELECT count(*) c FROM leads').get() as { c: number }).c, 1)
  assert.deepEqual(hiringFeedStatus(db, 'A', r.job_id!).map(x => [x.state, x.emails]), [['finished', 1]])
})

test('two overlapping intakes for the same company save it once', async () => {
  const db = mk()
  const [a, b] = await Promise.all([run(db, { get: okGet }), run(db, { get: okGet })])
  await Promise.all([a.crawl, b.crawl])
  assert.equal((db.prepare('SELECT count(*) c FROM leads').get() as { c: number }).c, 1)
  assert.equal((db.prepare('SELECT count(*) c FROM hiring_feed_crawl').get() as { c: number }).c, 1)
  assert.equal((db.prepare('SELECT count(*) c FROM scan_jobs').get() as { c: number }).c, 1)
  assert.equal([a, b].filter(x => x.job_id).length, 1)
})

test('a posting page that never answers is skipped within the page-phase limit', async () => {
  const db = mk()
  const t = Date.now()
  const r = await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sales development', { fetchFeed: async () => XML, fetchPage: () => new Promise(() => {}), pagePhaseMs: 40 })
  assert.ok(Date.now() - t < 2000); assert.equal(r.job_id, null); assert.equal(r.skipped.length, 1)
})

test('duplicates are refused by the database itself, not only by the application check', async () => {
  const db = mk()
  const r = await run(db, { get: okGet }); await r.crawl
  assert.throws(() => db.prepare("INSERT INTO hiring_feed_crawl(lead_id,tenant_id,job_id,company_key,status,started_at) VALUES('x','A','j','acmeco','reading',1)").run(), /UNIQUE/)
  db.prepare("INSERT INTO hiring_feed_crawl(lead_id,tenant_id,job_id,company_key,status,started_at) VALUES('y','B','j','acmeco','reading',1)").run()
})
