import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { createHiringFeedIntake, JobFeedError, matchRoles, parseFeedItems, parseRoleWords } from '../lib/scan/job-feed.ts'
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
