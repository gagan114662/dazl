// The real /api/hooks/first-party handler (#390): unknown tenant, bad or stale signature, opt-out and replay all store
// nothing new; a signed consented event lands as one first-party lead. Run by test/first-party-route.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { recordConfig, setCollection, signBody } from '../../lib/signals/first-party.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const { POST } = await import('../../app/api/hooks/first-party/route.ts')

const now = () => Math.floor(Date.now() / 1000)
const post = (tenant: string, raw: string, headers: Record<string, string>) =>
  POST(new NextRequest(`https://dazl.test/api/hooks/first-party?u=${tenant}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }))
const signed = (secret: string, raw: string, ts = now()) => ({ 'x-dazl-timestamp': String(ts), 'x-dazl-signature': signBody(secret, ts, raw) })

test('signed first-party hook: authenticates, honours opt-out, dedupes replays', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  setDb(db)
  const count = () => (raw.prepare("SELECT COUNT(*) AS n FROM lead_enrichments WHERE connector = 'first_party'").get() as { n: number }).n
  const secret = await recordConfig(db, 'tenantA', { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 }, 'actor')
  const body = JSON.stringify({ events: [{ id: 'evt-1', type: 'demo_request', occurred_at: new Date().toISOString(), page_url: 'https://seller.test/demo', consent: 'granted', person: { email: 'pat@acme.io', name: 'Pat' } }] })

  assert.equal((await post('nobody', body, signed(secret, body))).status, 404)
  assert.equal((await post('tenantA', body, signed('wrong-secret', body))).status, 401)
  assert.equal((await post('tenantA', body, signed(secret, body, now() - 3600))).status, 401) // outside the replay window
  assert.equal((await post('tenantA', body, {})).status, 401)
  assert.equal(count(), 0)

  await setCollection(db, 'tenantA', false)
  assert.equal((await post('tenantA', body, signed(secret, body))).status, 403) // opted out: nothing collected
  assert.equal(count(), 0)
  await setCollection(db, 'tenantA', true)

  const ok = await post('tenantA', body, signed(secret, body))
  assert.equal(ok.status, 200)
  assert.deepEqual((await ok.json()).counts, { created: 1 })
  const again = await post('tenantA', body, signed(secret, body)) // a replayed (re-signed) event is one event
  assert.deepEqual((await again.json()).counts, { duplicate: 1 })
  assert.equal(count(), 1)
  const lead = raw.prepare("SELECT name, contact, source_kind, review_reason FROM leads WHERE source_kind = 'first_party'").all()
  assert.deepEqual(lead, [{ name: 'Pat', contact: null, source_kind: 'first_party', review_reason: 'first_party_signal' }])
  assert.equal((await post('tenantA', '{"events":[]}', signed(secret, '{"events":[]}'))).status, 400)
  raw.close()
})
