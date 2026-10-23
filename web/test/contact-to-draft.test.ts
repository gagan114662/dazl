import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { publishedContact, contactSearchNote } from '../lib/outreach/published-email.ts'

// TEST-ONLY fixture (stubbed fetch, no network). Proves wiring: published contact page -> stored
// enrichment with page URL -> fresh template draft. It is not a qualified buyer and proves nothing about real sites.
const html = (b: string) => `<html><body>${b}</body></html>`
test('fixture site -> crawl stores role mailbox plus listed person with sources -> createDraft targets the mailbox only', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateMemory(db)
  saveMemory(db, 'A', { positioning: 'Synthetic fixture offer for wiring checks.' })
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Brightside Dental', null, 'Brightside Dental is hiring a front desk', 'https://news.example.test/a', 'Brightside Dental is hiring a front desk', 90, 80)
  const pages: Record<string, string> = {
    '/a': html('<a href="https://brightsidedental.com/">site</a>'),
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html('Brightside Dental <a href="/about">About</a><a href="/contact">Contact</a>'),
    '/about': html('<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p><h3>Dana Lee</h3><p>Owner</p>'),
    '/contact': html('<a href="mailto:hello@brightsidedental.com">hello</a>'),
  }
  const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-10-23T12:00:00Z') })
  const rows = db.prepare('SELECT kind, value, source_url, source_date FROM lead_enrichments ORDER BY kind').all()
  assert.deepEqual(rows, [
    { kind: 'email', value: 'hello@brightsidedental.com', source_url: 'https://brightsidedental.com/contact', source_date: '2026-10-23' },
    { kind: 'person', value: 'Dana Lee, Owner', source_url: 'https://brightsidedental.com/about', source_date: '2026-10-23' },
  ])
  const enr = db.prepare('SELECT connector, kind, value, label, source_url FROM lead_enrichments').all() as never[]
  const lead = { contact: null, enrichments: enr }
  assert.equal(publishedContact(lead)!.email, 'hello@brightsidedental.com')
  // The currentness gate is real: without a confirmed event date createDraft refuses. The fixture uses the same human-review baseline as sequences.test.ts.
  assert.throws(() => createDraft(db, 'A', 'L1', 'Seller'), /lead_currentness_unconfirmed/)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id='L1'").run()
  const id = createDraft(db, 'A', 'L1', 'Seller')
  const m = db.prepare('SELECT to_email, subject, body, status FROM outreach_messages WHERE id = ?').get(id) as { to_email: string; subject: string; body: string; status: string }
  assert.equal(m.to_email, 'hello@brightsidedental.com')
  assert.equal(m.status, 'draft')
  assert.ok(m.body.includes('https://brightsidedental.com/contact'), 'the draft cites the company contact page that actually shows the address')
  assert.ok(!m.body.includes('news.example.test'), 'the signal/news URL is never claimed as the address source')
  assert.ok(m.body.includes('Hi there,') && !m.body.includes('Dana'), 'a listed person is never auto-associated with the role mailbox or added to the greeting')
  assert.equal(contactSearchNote({ ...lead, confidence: 90, company_domain: 'x' }), null)
})
