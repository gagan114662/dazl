// GET / POST / DELETE /api/leads/verification-fixture with action 'first_touch' (#411) through the real handlers: the
// designated test tenant gets ONE confirmable test-only lead to its own allowlisted inbox, which the real autopilot can
// draft once it is confirmed; every other account is refused and nothing is written. Synthetic data; fetch throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET, POST, DELETE } from '../../app/api/leads/verification-fixture/route.ts'
import { setTestAddresses } from '../../lib/outreach/sequences.ts'
import { TEST_INBOX, draftBlockReason } from '../../lib/outreach/service.ts'
import { confirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { FIRST_TOUCH_FIXTURE_COMPANY } from '../../lib/scan/first-touch-fixture.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const hdr = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const call = (method: 'POST' | 'DELETE', body: unknown) =>
  (method === 'POST' ? POST : DELETE)(new NextRequest('http://localhost/api/leads/verification-fixture', { method, body: JSON.stringify(body), headers: hdr }))
const fixtureLeads = (db: Database.Database) => db.prepare('SELECT l.id, l.contact, j.user_id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.company = ?').all(FIRST_TOUCH_FIXTURE_COMPANY) as { id: string; contact: string; user_id: string }[]

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setTestAddresses(db, 'A', [TEST_INBOX])
  setScanDb(db)
  return db
}

test('first_touch: refused for every other account and malformed actions never create it; nothing written', async () => {
  const db = build()
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  setUser(null)
  assert.equal((await call('POST', { action: 'first_touch' })).status, 401)
  setUser({ ...B })
  const r = await call('POST', { action: 'first_touch' })
  assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'test_tenant_only' })
  assert.equal((await call('DELETE', { action: 'first_touch' })).status, 403)
  const g = await (await GET()).json() as { available: boolean; firstTouchExists: boolean }
  assert.equal(g.available, false); assert.equal(g.firstTouchExists, false)
  setUser({ ...A, role: 'viewer' })
  assert.equal((await call('POST', { action: 'first_touch' })).status, 403)
  assert.equal(fixtureLeads(db).length, 0)
  // a wrong-typed action is no action at all (the verification fixture), never the first-touch lead
  setUser(A)
  for (const body of [{ action: ['first_touch'] }, { action: { first_touch: true } }, ['first_touch'], 'first_touch']) {
    const fresh = build(); process.env.OUTREACH_TEST_TENANT_ID = 'A'
    const res = await call('POST', body)
    assert.equal(res.status, 200)
    assert.equal(fixtureLeads(fresh).length, 0, JSON.stringify(body))
  }
  assert.equal(fetches, 0)
})

test('first_touch: the test tenant gets one lead to its own inbox, held until confirmed, draftable after the real confirm; DELETE first_touch removes only it', async () => {
  const db = build()
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  setUser(A)
  const r = await call('POST', { action: 'first_touch', tenant_id: 'B' })
  assert.equal(r.status, 200)
  const f = await r.json() as { leadId: string; created: boolean }
  assert.equal(f.created, true)
  assert.equal(((await (await call('POST', { action: 'first_touch' })).json()) as { created: boolean }).created, false)
  const leads = fixtureLeads(db)
  assert.equal(leads.length, 1); assert.equal(leads[0].user_id, 'A'); assert.equal(leads[0].contact, TEST_INBOX)
  assert.equal(((await (await GET()).json()) as { firstTouchExists: boolean }).firstTouchExists, true)
  assert.equal(draftBlockReason(db, 'A', f.leadId), 'lead_currentness_unconfirmed')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', f.leadId), true)
  assert.equal(draftBlockReason(db, 'A', f.leadId), null)
  await call('POST', {}) // the verification fixture alongside it
  const del = await call('DELETE', { action: 'first_touch' })
  assert.equal(del.status, 200); assert.deepEqual(await del.json(), { deleted: true })
  assert.equal(fixtureLeads(db).length, 0)
  assert.ok(db.prepare("SELECT 1 FROM scan_jobs WHERE user_id = 'A' AND business_name = 'dazl verification fixture (test only)'").get(), 'only the first-touch fixture removed')
  assert.equal(fetches, 0)
})
