// #1036: /api/leads/verification-fixture action 'work_email' through the real handlers. No fixture is created any more (Find work
// email gives only an address published on the company's own site, #1036 / #1250); one an earlier release left is looked up by
// nobody and DELETE removes it. Synthetic data; fetch throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET, POST, DELETE } from '../../app/api/leads/verification-fixture/route.staging.ts'
import { GET as WE_GET, POST as WE_POST } from '../../app/api/leads/[lead]/work-email/route.ts'
import { setTestAddresses } from '../../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../../lib/outreach/service.ts'
import { saveCredential, setEnrichFallback } from '../../lib/connectors/store.ts'
import { WORK_EMAIL_FIXTURE_COMPANY } from '../../lib/people/work-email-eligible.ts'
import { insertLegacyWorkEmailFixture, LEGACY_FIXTURE_TARGET } from './legacy-work-email-fixture.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const hdr = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const call = (method: 'POST' | 'DELETE', body: unknown) =>
  (method === 'POST' ? POST : DELETE)(new NextRequest('http://localhost/api/leads/verification-fixture', { method, body: JSON.stringify(body), headers: hdr }))
const leads = (db: Database.Database) => db.prepare('SELECT l.id, j.user_id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.company = ?').all(WORK_EMAIL_FIXTURE_COMPANY) as { id: string; user_id: string }[]
const STAGING = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_PDL: '1', DAZL_STAGING_FAKE_ZEROBOUNCE: '1', EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' }
const setEnv = (on: boolean) => { for (const [k, v] of Object.entries(STAGING)) { if (on) process.env[k] = v; else delete process.env[k] } }

function build() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setTestAddresses(db, 'A', [TEST_INBOX])
  saveCredential(db, 'A', 'enrich:pdl', 'staging-fake-pdl-any-string-1036', master)
  saveCredential(db, 'A', 'enrich:apollo', 'real-looking-apollo-key-9999', master) // never called for the fixture lead
  setEnrichFallback(db, 'A', true)
  setScanDb(db); process.env.OUTREACH_TEST_TENANT_ID = 'A'
  return db
}

test('work_email fixture: no longer created for anyone (unknown action, nothing written); GET offers no create', async () => {
  const db = build()
  for (const [on, user] of [[true, A], [false, A], [true, B]] as const) {
    setEnv(on); setUser({ ...user })
    const r = await call('POST', { action: 'work_email' })
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'unknown_action' })
  }
  setEnv(true); setUser(A)
  const g = await (await GET()).json() as { workEmailAvailable?: boolean; workEmailExists: boolean }
  assert.equal(g.workEmailAvailable, undefined); assert.equal(g.workEmailExists, false)
  assert.equal(leads(db).length, 0); assert.equal(fetches, 0)
  setEnv(false)
})

test('a fixture an earlier release left: the real Find work email route looks nothing up and shows no stored fake answer; DELETE work_email removes it', async () => {
  const db = build(); setEnv(true); setUser(A)
  const f = insertLegacyWorkEmailFixture(db, 'A')
  const g = await (await GET()).json() as { workEmailExists: boolean }
  assert.equal(g.workEmailExists, true)
  const params = { params: Promise.resolve({ lead: f.leadId }) }
  const before = await (await WE_GET(new NextRequest(`http://localhost/api/leads/${f.leadId}/work-email`), params)).json() as { providers: { apollo: boolean; pdl: boolean; mailboxCheck: boolean; publishedOnly?: boolean }; lookups: unknown[] }
  assert.deepEqual([before.providers.apollo, before.providers.pdl, before.providers.mailboxCheck, before.providers.publishedOnly], [false, false, false, true])
  assert.deepEqual(before.lookups, [], 'the stored fake People Data Labs answer is not shown')
  const post = await WE_POST(new NextRequest(`http://localhost/api/leads/${f.leadId}/work-email`, { method: 'POST', body: JSON.stringify({ target: LEGACY_FIXTURE_TARGET }), headers: hdr }), params)
  assert.equal(post.status, 422); assert.equal((await post.json() as { lookup?: unknown }).lookup, undefined)

  const d = await call('DELETE', { action: 'work_email' })
  assert.equal(d.status, 200); assert.deepEqual(await d.json(), { deleted: true })
  assert.equal(leads(db).length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_email_lookups').get() as { n: number }).n, 0)
  assert.equal(fetches, 0, 'no network call')
  setEnv(false)
})

test('work_email_real (#1036 live check): staging test tenant only; malformed input is a 400; nothing written', async () => {
  const db = build(); setUser(A)
  setEnv(false)
  const off = await call('POST', { action: 'work_email_real', company: 'Bluebonnet Realty', url: 'https://bluebonnetrealty.com/', who: 'Owner' })
  assert.equal(off.status, 403); assert.deepEqual(await off.json(), { error: 'staging_only' })
  setEnv(true)
  const bad = await call('POST', { action: 'work_email_real', company: 'Bluebonnet Realty', url: 'http://10.0.0.1/', who: 'Owner' })
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: 'bad_input' })
  const g = await (await GET()).json() as { realCheckAvailable: boolean }
  assert.equal(g.realCheckAvailable, true)
  setUser({ ...B })
  const other = await call('POST', { action: 'work_email_real', company: 'x', url: 'nonsense', who: '' })
  assert.equal(other.status, 403, 'review R7: the gate answers before input validation'); assert.deepEqual(await other.json(), { error: 'test_tenant_only' })
  setUser(A)
  assert.equal((db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n, 0)
  assert.equal(fetches, 0)
  setEnv(false)
})
