// #1036: POST / DELETE /api/leads/verification-fixture with action 'work_email', then the real Find work email route on the
// fixture lead, through the real handlers. Only the designated test tenant with DAZL_ENV=staging and DAZL_STAGING_FAKE_PDL=1 gets
// the lead; the lookup answers come from the staging fake People Data Labs and fake ZeroBounce. Synthetic data; fetch throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET, POST, DELETE } from '../../app/api/leads/verification-fixture/route.ts'
import { GET as WE_GET, POST as WE_POST } from '../../app/api/leads/[lead]/work-email/route.ts'
import { setTestAddresses } from '../../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../../lib/outreach/service.ts'
import { saveCredential, setEnrichFallback } from '../../lib/connectors/store.ts'
import { WORK_EMAIL_FIXTURE_COMPANY } from '../../lib/people/work-email-eligible.ts'

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

test('work_email fixture: refused for other accounts and outside staging with the fake PDL; nothing written', async () => {
  const db = build()
  setEnv(true); setUser({ ...B })
  const r = await call('POST', { action: 'work_email' })
  assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'test_tenant_only' })
  setEnv(false); setUser(A)
  const p = await call('POST', { action: 'work_email' })
  assert.equal(p.status, 403); assert.deepEqual(await p.json(), { error: 'staging_fake_pdl_only' })
  const g = await (await GET()).json() as { workEmailAvailable: boolean; workEmailExists: boolean }
  assert.equal(g.workEmailAvailable, false); assert.equal(g.workEmailExists, false)
  assert.equal(leads(db).length, 0); assert.equal(fetches, 0)
})

test('work_email fixture on staging: one lead; the real Find work email route answers from the fakes; DELETE work_email removes it', async () => {
  const db = build(); setEnv(true); setUser(A)
  const c = await call('POST', { action: 'work_email' })
  assert.equal(c.status, 200)
  const f = await c.json() as { leadId: string; created: boolean; people: { target: string; expect: string }[] }
  assert.equal(f.created, true); assert.equal(f.people.length, 4); assert.deepEqual(leads(db).map(l => l.user_id), ['A'])
  const g = await (await GET()).json() as { workEmailAvailable: boolean; workEmailExists: boolean }
  assert.equal(g.workEmailAvailable, true); assert.equal(g.workEmailExists, true)

  const params = { params: Promise.resolve({ lead: f.leadId }) }
  const before = await (await WE_GET(new NextRequest(`http://localhost/api/leads/${f.leadId}/work-email`), params)).json() as { providers: { apollo: boolean; pdl: boolean; mailboxCheck: boolean } }
  assert.deepEqual([before.providers.apollo, before.providers.pdl, before.providers.mailboxCheck], [false, true, true])
  const post = (target: string) => WE_POST(new NextRequest(`http://localhost/api/leads/${f.leadId}/work-email`, { method: 'POST', body: JSON.stringify({ target }), headers: hdr }), params)
  const valid = await post(f.people[0].target)
  assert.equal(valid.status, 200)
  const v = await valid.json() as { status: string; lookup: { address: string | null; mailbox_check: string; mailbox_verifier: string } }
  assert.equal(v.status, 'unverified'); assert.equal(v.lookup.mailbox_check, 'valid'); assert.equal(v.lookup.mailbox_verifier, 'zerobounce-staging-fake')
  assert.match(v.lookup.address ?? '', /^staging-valid\.testbuyer@/)
  const spam = await (await post(f.people[3].target)).json() as { lookup: { address: string | null; mailbox_check: string } }
  assert.equal(spam.lookup.mailbox_check, 'refused'); assert.equal(spam.lookup.address, null, 'a do-not-mail address is never sent to the browser')

  const d = await call('DELETE', { action: 'work_email' })
  assert.equal(d.status, 200); assert.deepEqual(await d.json(), { deleted: true })
  assert.equal(leads(db).length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_email_lookups').get() as { n: number }).n, 0)
  assert.equal(fetches, 0, 'no network call')
  setEnv(false)
})
