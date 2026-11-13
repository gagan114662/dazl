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
  // a misspelled or wrong-typed action, or a body that is not an object, is refused (400) and creates nothing at all
  setUser(A)
  for (const body of [{ action: ['first_touch'] }, { action: { first_touch: true } }, { action: null }, { action: 'first-touch' }, { action: 'firsttouch' }, ['first_touch'], 'first_touch']) {
    const fresh = build(); process.env.OUTREACH_TEST_TENANT_ID = 'A'
    const res = await call('POST', body)
    assert.equal(res.status, 400, JSON.stringify(body)); assert.deepEqual(await res.json(), { error: 'unknown_action' })
    assert.equal(fixtureLeads(fresh).length, 0, JSON.stringify(body))
    assert.equal((fresh.prepare("SELECT count(*) n FROM scan_jobs WHERE user_id = 'A'").get() as { n: number }).n, 0, `nothing created: ${JSON.stringify(body)}`)
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

test('DELETE: a misspelled or wrong-typed action is a 400 and removes nothing; only a DELETE with no action removes every fixture', async () => {
  const fixtureJobs = (db: Database.Database) => (db.prepare("SELECT count(*) n FROM scan_jobs WHERE user_id = 'A' AND business_name LIKE 'dazl %fixture%'").get() as { n: number }).n
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  setUser(A)
  const db = build()
  assert.equal((await call('POST', {})).status, 200)
  assert.equal((await call('POST', { action: 'first_touch' })).status, 200)
  assert.equal(fixtureJobs(db), 2)
  for (const body of [{ action: 'first-touch' }, { action: ['first_touch'] }, { action: 'firsttouch' }, { action: 'review_draft' }, { action: null }, { action: 1 }, ['first_touch'], 'first_touch']) {
    const res = await call('DELETE', body)
    assert.equal(res.status, 400, JSON.stringify(body)); assert.deepEqual(await res.json(), { error: 'unknown_action' })
    assert.equal(fixtureJobs(db), 2, `nothing removed: ${JSON.stringify(body)}`)
  }
  assert.equal((await call('DELETE', {})).status, 200)
  assert.equal(fixtureJobs(db), 0, 'a DELETE with no action still removes every fixture')
  assert.equal(fetches, 0)
})

test('a misspelled key, a JSON null, invalid JSON or an unreadable body is a 400 on POST and DELETE: nothing created, nothing removed; only "{}" or an empty body is no action', async () => {
  const fixtureJobs = (db: Database.Database) => (db.prepare("SELECT count(*) n FROM scan_jobs WHERE user_id = 'A' AND business_name LIKE 'dazl %fixture%'").get() as { n: number }).n
  const raw = (method: 'POST' | 'DELETE', body: BodyInit) =>
    (method === 'POST' ? POST : DELETE)(new NextRequest('http://localhost/api/leads/verification-fixture', { method, body, headers: hdr, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]))
  const broken = () => new ReadableStream({ start(c) { c.error(new Error('read failed')) } })
  const bodies: [string, () => BodyInit][] = [
    ['{"acton":"first_touch"}', () => '{"acton":"first_touch"}'], ['{"Action":"first_touch"}', () => '{"Action":"first_touch"}'],
    ['null', () => 'null'], ['{', () => '{'], ['unreadable', broken],
  ]
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  setUser(A)
  for (const method of ['POST', 'DELETE'] as const) {
    const db = build()
    if (method === 'DELETE') { assert.equal((await call('POST', {})).status, 200); assert.equal((await call('POST', { action: 'first_touch' })).status, 200) }
    const n = fixtureJobs(db)
    for (const [label, body] of bodies) {
      const res = await raw(method, body())
      assert.equal(res.status, 400, `${method} ${label}`); assert.deepEqual(await res.json(), { error: 'unknown_action' })
      assert.equal(fixtureJobs(db), n, `${method} ${label}: nothing created or removed`)
    }
  }
  // the controls' own "no action" body ({action: undefined} serialises to {}) and an empty body still remove everything
  const db = build()
  await call('POST', {}); await call('POST', { action: 'first_touch' })
  assert.equal(fixtureJobs(db), 2)
  assert.equal((await raw('DELETE', '')).status, 200)
  assert.equal(fixtureJobs(db), 0)
  assert.equal(fetches, 0)
})
