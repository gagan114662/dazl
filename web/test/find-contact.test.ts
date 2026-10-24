import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { findContactForConfirmedLead } from '../lib/scan/find-contact.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { contactSearchNote } from '../lib/outreach/published-email.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'

const html = (b: string) => `<html><body>${b}</body></html>`
function fixture(confirmed: number | null, confidence: number | null = null) {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec("CREATE TABLE scan_jobs (id TEXT, user_id TEXT); CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, human_confirmed_at INTEGER, human_confirmed_from TEXT, source_kind TEXT)")
  db.prepare("INSERT INTO scan_jobs VALUES ('j1','u1'),('j2','u2')").run()
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Stabyl','https://jobs.example/a','source_review_required',?,50,NULL,?,'source_review_required',NULL),('l2','j2','Stabyl','https://jobs.example/a',NULL,NULL,50,NULL,1,NULL,NULL)").run(confidence, confirmed)
  return db
}
const pages: Record<string, string> = {
  '/a': html('<a href="https://stabyl.com">site</a>'), '/robots.txt': '', '/': html('Stabyl home <a href="/contact-us">c</a>'), '/contact-us': html('Email: hello@stabyl.com'),
}
const get: Get = async url => { const p = pages[new URL(url).pathname]; return p === undefined ? { status: 404, body: '', finalUrl: url } : { status: 200, body: p, finalUrl: url } }

test('a confirmed lead gets a published own-domain mailbox stored with its page URL', async () => {
  const db = fixture(1700000000)
  const r = await findContactForConfirmedLead(db, 'u1', 'l1', { get, gapMs: 0, env: {} })
  assert.deepEqual(r, { status: 'done', contacts: 1 })
  const row = db.prepare("SELECT kind, value, source_url, connector FROM lead_enrichments WHERE lead_id = 'l1' AND kind <> 'domain'").get()
  assert.deepEqual(row, { kind: 'email', value: 'hello@stabyl.com', source_url: 'https://stabyl.com/contact-us', connector: 'sitecrawl' })
  // the confirmation and review state are untouched
  const l = db.prepare("SELECT review_reason, human_confirmed_at, confidence FROM leads WHERE id = 'l1'").get()
  assert.deepEqual(l, { review_reason: 'source_review_required', human_confirmed_at: 1700000000, confidence: null })
})

test('unconfirmed leads, other users leads, and a disabled switch are refused with no fetch', async () => {
  let hits = 0
  const counting: Get = async u => { hits++; return get(u) }
  assert.equal((await findContactForConfirmedLead(fixture(null), 'u1', 'l1', { get: counting, gapMs: 0, env: {} })).status, 'not_confirmed')
  assert.equal((await findContactForConfirmedLead(fixture(1), 'u1', 'l2', { get: counting, gapMs: 0, env: {} })).status, 'not_found')
  assert.equal((await findContactForConfirmedLead(fixture(1), 'u1', 'missing', { get: counting, gapMs: 0, env: {} })).status, 'not_found')
  assert.equal((await findContactForConfirmedLead(fixture(1), 'u1', 'l1', { get: counting, gapMs: 0, env: { SITECRAWL_ENABLED: '0' } })).status, 'disabled')
  assert.equal(hits, 0)
})

test('robots-disallowed site yields nothing and the page says so only as unproven', async () => {
  const db = fixture(1)
  const blocked: Get = async url => new URL(url).pathname === '/robots.txt' ? { status: 200, body: 'User-agent: *\nDisallow: /', finalUrl: url } : get(url)
  const r = await findContactForConfirmedLead(db, 'u1', 'l1', { get: blocked, gapMs: 0, env: {} })
  assert.deepEqual(r, { status: 'done', contacts: 0 })
})

test('contact note for a confirmed unverified lead points at the user-requested search', () => {
  const n = contactSearchNote({ contact: null, confidence: null, human_confirmed_at: 1 } as never)
  assert.match(String(n), /ask dazl to look on the company website/)
  assert.match(String(contactSearchNote({ contact: null, confidence: null, human_confirmed_at: null } as never)), /only runs for machine-verified/)
})

test('person/counterparty/test rows are not offered a company-contact search', async () => {
  const { companySearchEligible } = await import('../lib/scan/find-contact-eligible.ts')
  const ok = { human_confirmed_from: 'source_review_required', source_kind: 'ats', company: 'Acme' }
  assert.equal(companySearchEligible(ok), true)
  for (const from of ['author_post', 'counterparty_signal']) assert.equal(companySearchEligible({ ...ok, human_confirmed_from: from }), false)
  assert.equal(companySearchEligible({ ...ok, human_confirmed_from: 'self_description' }), true)
  assert.equal(companySearchEligible({ ...ok, source_kind: 'test' }), false)
  assert.equal(companySearchEligible({ ...ok, company: '' }), false)
})
