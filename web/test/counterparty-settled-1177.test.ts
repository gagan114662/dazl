// #1177: a customer-mention row (counterparty_signal — the cited page is another company's customer story that mentions
// this company) is refused Find contact and Find work email today, even when the company and a buyer-role person are
// established independently of the cited page. The exception: a settled own site (a sitecrawl domain row whose basis is
// evidence_own_domain, or a domain the user confirmed) plus a buyer-role person read from that site. author_post stays
// refused everywhere, and an unsettled counterparty row stays refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createJob } from '../lib/scan/store.ts'
import { reviewLaneWorkEmailTargets } from '../lib/people/work-email-review-lane.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'
import { findContactForConfirmedLead } from '../lib/scan/find-contact.ts'
import { recordEmailGuesses } from '../lib/people/email-pattern.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'

const NOW = Date.parse('2026-11-13T18:40:00Z')
const row = (kind: string, value: string, over: Record<string, unknown> = {}) => ({ connector: 'sitecrawl', kind, value, label: null as string | null, source_url: 'https://www.beneschlaw.example/contact-us/', source_date: '2026-11-13', retrieved_at: Math.floor(NOW / 1000), confidence: null, ...over })
const settled = row('domain', 'beneschlaw.example|evidence_own_domain', { label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://www.beneschlaw.example/' })
const person = row('person', 'Jordan Hammond, Chief Marketing Officer')
const laneLead = (over: Record<string, unknown> = {}) => ({ id: 'a1'.repeat(12), contact: null, company: 'Benesch', quarantined_at: null, source_kind: 'query', human_confirmed_from: null, review_reason: 'counterparty_signal', enrichments: [settled, person], ...over })
const WHO = 'Chief Marketing Officer; Managing Partner'

test('#1177 review lane: a counterparty row with a settled own site and a buyer-role person offers the lookup', () => {
  assert.deepEqual(reviewLaneWorkEmailTargets(laneLead(), WHO, NOW), [{ key: 'Jordan Hammond|Chief Marketing Officer', name: 'Jordan Hammond', title: 'Chief Marketing Officer' }])
})

test('#1177 review lane: a settled row naming ANOTHER company is not this lead\'s own site (the rendered-page failure)', () => {
  // The shape the Leads page rendered twice: a 'Counterparty Co' row carrying a settled harlowreedlaw.example
  // row and that site's buyer. The domain is settled, but it is Harlow Reed's site, not Counterparty Co's, so
  // the exception must not fire - the crawl only labels a domain the company's own when its name label matches
  // the company name, and the exception re-checks that match.
  const other = row('domain', 'harlowreedlaw.example|evidence_own_domain', { label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://www.harlowreedlaw.example/' })
  const otherPerson = row('person', 'Jordan Hammond, Chief Marketing Officer', { source_url: 'https://www.harlowreedlaw.example/contact-us/' })
  assert.deepEqual(reviewLaneWorkEmailTargets(laneLead({ company: 'Counterparty Co', enrichments: [other, otherPerson] }), WHO, NOW), [])
})

test('#1177 review lane: counterparty without a settled own site, or without a buyer-role person, stays refused; author_post always stays refused', () => {
  const guessed = row('domain', 'beneschlaw.example|name_probe', { label: 'domain-basis-v1:name_probe' })
  assert.deepEqual(reviewLaneWorkEmailTargets(laneLead({ enrichments: [guessed, person] }), WHO, NOW), [], 'domain only guessed from the name')
  assert.deepEqual(reviewLaneWorkEmailTargets(laneLead({ enrichments: [person] }), WHO, NOW), [], 'no website recorded')
  assert.deepEqual(reviewLaneWorkEmailTargets(laneLead({ enrichments: [settled] }), WHO, NOW), [], 'no buyer-role person')
  assert.deepEqual(reviewLaneWorkEmailTargets(laneLead({ review_reason: 'author_post' }), WHO, NOW), [], 'author_post with a settled site')
})

function seeded(reviewReason: string, ownDomain = true) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'legal', location: 'Chicago' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'Chicago law firms', who: ['Chief Marketing Officer'], where: ['Chicago, IL'], signals: [] }), job)
  const id = 'b2'.repeat(12)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, confidence, review_reason) VALUES (?, ?, '', 'Benesch', 'opened an office', 'https://www.beneschlaw.example/news', 80, ?)").run(id, job, reviewReason)
  const add = (kind: string, value: string, label: string | null, url: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, 70, ?, '2026-11-13', ?)").run(randomBytes(12).toString('hex'), id, kind, value, label, url, Math.floor(NOW / 1000))
  if (ownDomain) add('domain', 'beneschlaw.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://www.beneschlaw.example/')
  add('person', 'Jordan Hammond, Chief Marketing Officer', null, 'https://www.beneschlaw.example/contact-us/')
  return { db, id }
}

test('#1177 server: Find work email runs for a counterparty row whose own site is settled (the printed address is found)', async () => {
  const s = seeded('counterparty_signal')
  recordEmailGuesses(s.db, 'A', s.id, 'beneschlaw.example', [], ['Jordan Hammond, Chief Marketing Officer'], { env: {}, homeText: '71 S Wacker Dr, Chicago, IL 60606', seen: [{ address: 'jhammond@beneschlaw.example', url: 'https://www.beneschlaw.example/contact-us/' }] })
  const r = await findWorkEmail(s.db, 'A', s.id, 'Jordan Hammond|Chief Marketing Officer', { now: Math.floor(NOW / 1000) })
  assert.equal(r.status, 'published', JSON.stringify(r))
})

test('#1177 server: a counterparty TEST row gets no exception, even with its own settled domain', async () => {
  const s = seeded('counterparty_signal')
  s.db.prepare("UPDATE leads SET source_kind = 'test' WHERE id = ?").run(s.id)
  const r = await findWorkEmail(s.db, 'A', s.id, { env: {}, fetch: (async () => { throw new Error('must not fetch for a test row') }) as never, now: NOW })
  assert.equal(r.status, 'not_eligible', 'the counterparty path still applies the source_kind test check')
})

test('#1177 server: a counterparty row whose settled domain names another company is refused', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'legal', location: 'Chicago' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'Chicago law firms', who: ['Chief Marketing Officer'], where: ['Chicago, IL'], signals: [] }), job)
  const id = 'c3'.repeat(12)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, confidence, review_reason) VALUES (?, ?, '', 'Counterparty Co', 'opened an office', 'https://www.news.example/x', 80, 'counterparty_signal')").run(id, job)
  const add = (kind: string, value: string, label: string | null, url: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, 70, ?, '2026-11-13', ?)").run(randomBytes(12).toString('hex'), id, kind, value, label, url, Math.floor(NOW / 1000))
  add('domain', 'harlowreedlaw.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://www.harlowreedlaw.example/')
  add('person', 'Jordan Hammond, Chief Marketing Officer', null, 'https://www.harlowreedlaw.example/contact-us/')
  const r = await findWorkEmail(db, 'A', id, 'Jordan Hammond|Chief Marketing Officer', { now: Math.floor(NOW / 1000) })
  assert.equal(r.status, 'not_eligible', JSON.stringify(r))
})

test('#1177 server: a counterparty row with no settled own site is refused, and author_post is refused even with one', async () => {
  const unsettled = seeded('counterparty_signal', false)
  const r1 = await findWorkEmail(unsettled.db, 'A', unsettled.id, 'Jordan Hammond|Chief Marketing Officer', { now: Math.floor(NOW / 1000) })
  assert.equal(r1.status, 'site_unsettled', JSON.stringify(r1))
  const author = seeded('author_post')
  const r2 = await findWorkEmail(author.db, 'A', author.id, 'Jordan Hammond|Chief Marketing Officer', { now: Math.floor(NOW / 1000) })
  assert.equal(r2.status, 'not_eligible', JSON.stringify(r2))
})

// Find contact (confirmed leads): the same exception, judged from the lead's stored domain row.
const html = (b: string) => `<html><body>${b}</body></html>`
const pages: Record<string, string> = {
  '/a': html('<a href="https://stabyl.com">site</a>'), '/robots.txt': '', '/': html('Stabyl home <a href="/contact-us">c</a>'), '/contact-us': html('Email: hello@stabyl.com'),
}
const get: Get = async url => { const p = pages[new URL(url).pathname]; return p === undefined ? { status: 404, body: '', finalUrl: url } : { status: 200, body: p, finalUrl: url } }
function contactFixture(from: string, ownDomain: boolean) {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE scan_jobs (id TEXT, user_id TEXT); CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, human_confirmed_at INTEGER, human_confirmed_from TEXT, source_kind TEXT, contact TEXT)")
  db.prepare("INSERT INTO scan_jobs VALUES ('j1','u1')").run()
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://jobs.example/a','source_review_required',NULL,50,NULL,1700000000,?,'ats',NULL)").run(from)
  if (ownDomain) db.prepare("INSERT INTO lead_enrichments (lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('l1','u1','sitecrawl','domain','stabyl.com|evidence_own_domain','domain-basis-v1:evidence_own_domain','https://stabyl.com/','2026-11-13',1700000000)").run()
  return db
}

test('#1177 find contact: a confirmed counterparty lead with a settled own site is searched; without the row, or as author_post, it is not', async () => {
  const ok = await findContactForConfirmedLead(contactFixture('counterparty_signal', true), 'u1', 'l1', { get, gapMs: 0, env: {} })
  assert.equal(ok.status, 'done', JSON.stringify(ok)); assert.ok(ok.contacts >= 1)
  assert.equal((await findContactForConfirmedLead(contactFixture('counterparty_signal', false), 'u1', 'l1', { get, gapMs: 0, env: {} })).status, 'not_company')
  assert.equal((await findContactForConfirmedLead(contactFixture('author_post', true), 'u1', 'l1', { get, gapMs: 0, env: {} })).status, 'not_company')
})
