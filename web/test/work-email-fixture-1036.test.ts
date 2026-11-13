// #1036 live check (Hermes 2026-11-13 09:21): a TEST-ONLY staging fixture lead so Find work email can be clicked through on staging
// at $0. The fixture inserts rows only; every lookup below runs the REAL findWorkEmail with the REAL staging fake People Data Labs
// (DAZL_STAGING_FAKE_PDL) and the REAL staging fake ZeroBounce (DAZL_STAGING_FAKE_ZEROBOUNCE). The fetch stub fails on ANY call:
// the fakes need no network, and Apollo must never be called for the fixture lead.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { saveCredential, setEnrichFallback } from '../lib/connectors/store.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { FixtureError } from '../lib/outreach/test-fixture.ts'
import { findWorkEmail, workEmailsFor } from '../lib/people/work-email.ts'
import { isWorkEmailFixtureLead, workEmailCopy, workEmailLeadEligible, workEmailTargets, siteSettled, targetKey, WORK_EMAIL_FIXTURE_COMPANY } from '../lib/people/work-email-eligible.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { createWorkEmailFixture, deleteWorkEmailFixture, workEmailFixtureAvailable, workEmailFixtureExists, WORK_EMAIL_FIXTURE_PEOPLE, WORK_EMAIL_FIXTURE_SITE } from '../lib/scan/work-email-fixture.ts'

const T = 'work-email-fixture-tenant'
const master = randomBytes(32)
const STAGING = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_PDL: '1', DAZL_STAGING_FAKE_ZEROBOUNCE: '1', EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' }
const PROD = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' } // no DAZL_ENV=staging: no fakes
const noNetwork = (calls: string[]) => (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error(`no network in this test: ${String(u)}`) }) as typeof fetch

function setup(opts: { apollo?: boolean } = {}) {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateScan(db)
  process.env.OUTREACH_TEST_TENANT_ID = T
  setTestAddresses(db, T, [TEST_INBOX])
  saveCredential(db, T, 'enrich:pdl', 'staging-fake-pdl-any-string-1036', master)
  if (opts.apollo) { saveCredential(db, T, 'enrich:apollo', 'real-looking-apollo-key-9999', master); setEnrichFallback(db, T, true) }
  return db
}
const target = (name: string) => { const p = WORK_EMAIL_FIXTURE_PEOPLE.find(x => x.name === name)!; return `${p.name}|${p.title}` }

test('#1036 fixture: only the test tenant with the staging fake PDL may create it; it is idempotent and labelled test only', () => {
  const db = setup()
  assert.throws(() => createWorkEmailFixture(db, 'someone-else', STAGING), (e: unknown) => e instanceof FixtureError && e.code === 'test_tenant_only')
  assert.throws(() => createWorkEmailFixture(db, T, PROD), (e: unknown) => e instanceof FixtureError && e.code === 'staging_fake_pdl_only', 'production (no staging fake PDL) can never create it')
  assert.throws(() => createWorkEmailFixture(db, T, { DAZL_STAGING_FAKE_PDL: '1' }), (e: unknown) => e instanceof FixtureError && e.code === 'staging_fake_pdl_only', 'the flag alone, without DAZL_ENV=staging, is not enough')
  assert.equal(workEmailFixtureAvailable(db, T, PROD), false); assert.equal(workEmailFixtureAvailable(db, T, STAGING), true)
  const a = createWorkEmailFixture(db, T, STAGING), b = createWorkEmailFixture(db, T, STAGING)
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.leadId, b.leadId)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n, 1)
  const lead = db.prepare('SELECT company, source_kind, contact FROM leads WHERE id = ?').get(a.leadId) as { company: string; source_kind: string; contact: string | null }
  assert.deepEqual(lead, { company: WORK_EMAIL_FIXTURE_COMPANY, source_kind: 'test', contact: null })
  assert.match(lead.company, /test only/)
})

test('#1036 fixture lead: the site is settled and all four buyer-role people are Find work email targets (what the Leads page renders)', () => {
  const db = setup(); const f = createWorkEmailFixture(db, T, STAGING)
  const rows = enrichmentsForLeads(db, T, [f.leadId])[f.leadId]
  const site = identityOf({ id: f.leadId, contact: null }, rows)
  assert.ok(siteSettled(site), JSON.stringify(site)); assert.equal(site!.site, WORK_EMAIL_FIXTURE_SITE)
  assert.deepEqual(workEmailTargets(rows, '', Date.now(), site).map(targetKey).sort(), WORK_EMAIL_FIXTURE_PEOPLE.map(p => `${p.name}|${p.title}`).sort())
  // The UI rule: this lead may offer the button although it is a fixture row; any other test row may not; real company rows still may.
  assert.equal(workEmailLeadEligible({ source_kind: 'test', company: WORK_EMAIL_FIXTURE_COMPANY }), true)
  assert.equal(workEmailLeadEligible({ source_kind: 'test', company: 'dazl verification fixture A (test only)' }), false)
  assert.equal(workEmailLeadEligible({ source_kind: 'news', company: 'Harbor Dental' }), true)
  assert.equal(isWorkEmailFixtureLead({ source_kind: 'news', company: WORK_EMAIL_FIXTURE_COMPANY }), false, 'a real row with the same name is never the fixture')
})

test('#1036 fixture click-through on staging fakes: valid -> checked; catch-all -> found, not checked; invalid / spamtrap -> address never sent', async () => {
  const db = setup(); const f = createWorkEmailFixture(db, T, STAGING); const calls: string[] = []
  const run = (name: string) => findWorkEmail(db, T, f.leadId, target(name), { fetchImpl: noNetwork(calls), master, env: STAGING })
  const row = (r: Awaited<ReturnType<typeof run>>) => (r as { row: Parameters<typeof workEmailCopy>[0] }).row

  const valid = await run('Valid Testbuyer')
  assert.equal(valid.status, 'unverified', JSON.stringify(valid)); assert.equal(row(valid).provider, 'pdl')
  assert.equal(row(valid).address, `staging-valid.testbuyer@${WORK_EMAIL_FIXTURE_SITE}`)
  assert.deepEqual([row(valid).mailbox_check, row(valid).mailbox_verifier], ['valid', 'zerobounce-staging-fake'])
  const vc = workEmailCopy(row(valid)); assert.equal(vc.headline, 'Checked work email'); assert.equal(vc.checked, true)
  assert.match(vc.note, /STAGING TEST verifier \(not a real mailbox check\)/)

  const catchall = await run('Catchall Testbuyer')
  assert.equal(row(catchall).mailbox_check, 'catch_all'); const cc = workEmailCopy(row(catchall))
  assert.equal(cc.headline, 'Found, not checked'); assert.equal(cc.checked, false); assert.equal(cc.showAddress, true)

  for (const [name, check, headline] of [['Invalid Testbuyer', 'undeliverable', 'Not shown: mailbox does not exist'], ['Spamtrap Testbuyer', 'refused', 'Not shown: flagged as do-not-mail']] as const) {
    const r = await run(name)
    assert.equal(row(r).mailbox_check, check); assert.equal(row(r).address, null, `${name}: no address in the POST answer`)
    assert.equal(workEmailCopy(row(r)).headline, headline)
  }
  const shown = workEmailsFor(db, T, f.leadId)
  assert.equal(shown.length, 4)
  assert.deepEqual(shown.filter(r => r.address === null).map(r => r.target).sort(), [target('Invalid Testbuyer'), target('Spamtrap Testbuyer')].sort(), 'GET hides the same two')
  assert.deepEqual(calls, [], 'no network call at all: the fakes answered')
})

test('#1036 fixture lead never reaches a real provider: Apollo is skipped even when saved, and without the staging fake PDL no lookup runs', async () => {
  const db = setup({ apollo: true }); const f = createWorkEmailFixture(db, T, STAGING); const calls: string[] = []
  const r = await findWorkEmail(db, T, f.leadId, target('Valid Testbuyer'), { fetchImpl: noNetwork(calls), master, env: STAGING })
  assert.equal(r.status, 'unverified'); assert.deepEqual(calls, [], 'Apollo was never called for the fixture lead')
  const prodCalls: string[] = []
  const p = await findWorkEmail(db, T, f.leadId, target('Catchall Testbuyer'), { fetchImpl: noNetwork(prodCalls), master, env: PROD })
  assert.equal(p.status, 'not_eligible'); assert.deepEqual(prodCalls, [])
  assert.equal(workEmailsFor(db, T, f.leadId).filter(x => x.target === target('Catchall Testbuyer')).length, 0, 'nothing stored')
  delete process.env.OUTREACH_TEST_TENANT_ID
  const other = await findWorkEmail(db, T, f.leadId, target('Catchall Testbuyer'), { fetchImpl: noNetwork(prodCalls), master, env: STAGING })
  assert.equal(other.status, 'not_eligible', 'not the designated test tenant any more: refused'); assert.deepEqual(prodCalls, [])
})

test('#1036 fixture delete removes its job, lead, enrichments and the lookups stored for it, and nothing else', async () => {
  const db = setup(); const f = createWorkEmailFixture(db, T, STAGING)
  await findWorkEmail(db, T, f.leadId, target('Valid Testbuyer'), { fetchImpl: noNetwork([]), master, env: STAGING })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('keepjob', ?, 'Real play', 'software', 'US', 'done')").run(T)
  assert.deepEqual(deleteWorkEmailFixture(db, T), { deleted: true })
  assert.equal(workEmailFixtureExists(db, T), false)
  const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n
  assert.equal(n('SELECT COUNT(*) AS n FROM leads WHERE id = ?', f.leadId), 0)
  assert.equal(n('SELECT COUNT(*) AS n FROM lead_enrichments WHERE lead_id = ?', f.leadId), 0)
  assert.equal(n('SELECT COUNT(*) AS n FROM work_email_lookups WHERE lead_id = ?', f.leadId), 0)
  assert.equal(n("SELECT COUNT(*) AS n FROM scan_jobs WHERE id = 'keepjob'"), 1, 'a real play is untouched')
  assert.deepEqual(deleteWorkEmailFixture(db, T), { deleted: false })
  delete process.env.OUTREACH_TEST_TENANT_ID
  assert.throws(() => deleteWorkEmailFixture(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'test_tenant_only')
})
