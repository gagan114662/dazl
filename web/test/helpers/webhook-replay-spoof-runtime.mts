// #887 guard: the three signed webhook receivers already refuse unsigned, forged, tampered, cross-tenant and (where
// the scheme signs a timestamp) stale or future deliveries, and an authenticated replay is answered with the route's
// existing success/duplicate response without being processed twice. Each route is driven with its own signing
// scheme: Cal.com X-Cal-Signature-256 = HMAC(secret, body) (Cal.com signs no timestamp, so none is checked here);
// first-party X-Dazl-Signature = HMAC(secret, `${ts}.${body}`) inside the replay window; Stripe-Signature
// t=..,v1=HMAC(secret, `${t}.${body}`) inside 300s. Guards existing behaviour; no route code changes with it.
// Run by test/webhook-replay-spoof.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_guard_' + randomBytes(8).toString('hex')
const { setDb, sqliteDb } = await import('../../lib/db/client.ts')
const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
const { rotateSecret } = await import('../../lib/calcom/index.ts')
const { recordConfig, signBody } = await import('../../lib/signals/first-party.ts')
const calcom = await import('../../app/api/hooks/calcom/route.ts')
const firstParty = await import('../../app/api/hooks/first-party/route.ts')
const stripe = await import('../../app/api/billing/webhook/route.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
const db = sqliteDb(raw)
setDb(db)
const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex')
const nowS = () => Math.floor(Date.now() / 1000)
const req = (url: string, body: string, headers: Record<string, string>) => new NextRequest(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })

test('Cal.com: body HMAC only; refusals store nothing; a signed replay answers duplicate and records once', async () => {
  const A = 'tenantA_cal', B = 'tenantB_cal'
  const sa = await rotateSecret(db, A), sb = await rotateSecret(db, B)
  const post = (tenant: string, body: string, sig?: string) => calcom.POST(req(`https://dazl.test/api/hooks/calcom?u=${tenant}`, body, sig === undefined ? {} : { 'x-cal-signature-256': sig }))
  const body = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'bk-1', attendees: [{ email: 'pat@acme.io', name: 'Pat' }] } })
  const rows = () => n('SELECT COUNT(*) AS n FROM calcom_bookings')
  assert.equal((await post(A, body)).status, 401, 'unsigned')
  assert.equal((await post(A, body, '')).status, 401, 'empty signature')
  assert.equal((await post(A, body, 'not-hex')).status, 401, 'malformed signature')
  assert.equal((await post(A, body, hmac('wrong', body))).status, 401, 'wrong secret')
  assert.equal((await post(A, body, hmac(sb, body))).status, 401, "another tenant's secret")
  assert.equal((await post(A, body.replace('bk-1', 'bk-2'), hmac(sa, body))).status, 401, 'tampered body')
  assert.equal((await post('nobody_x', body, hmac(sa, body))).status, 404, 'unknown tenant')
  assert.equal(rows(), 0)
  const first = await post(A, body, hmac(sa, body))
  assert.equal(first.status, 200); assert.notEqual((await first.json()).outcome, 'duplicate')
  for (const sig of [hmac(sa, body), hmac(sa, body).toUpperCase()]) {
    const again = await post(A, body, sig)
    assert.equal(again.status, 200); assert.deepEqual(await again.json(), { ok: true, outcome: 'duplicate', status: 'scheduled' })
  }
  assert.equal(rows(), 1, 'the replay recorded nothing new')
  const other = await post(B, body, hmac(sb, body)) // the same booking signed by B is B's own, never A's duplicate
  assert.equal(other.status, 200); assert.notEqual((await other.json()).outcome, 'duplicate')
  assert.equal(n("SELECT COUNT(*) AS n FROM calcom_bookings WHERE tenant_id = 'tenantA_cal'"), 1)
})

test('first-party: ts.body HMAC in the replay window; refusals are a uniform 404; a re-signed replay is one event', async () => {
  process.env.DAZL_FIRST_PARTY_ENABLED = '1'
  const A = 'tenantA_fp', B = 'tenantB_fp'
  const cfg = { site_domain: 'seller.test', basis: 'consent' as const, privacy_url: 'https://seller.test/privacy', retention_days: 90 }
  const sa = await recordConfig(db, A, cfg, 'actor'), sb = await recordConfig(db, B, cfg, 'actor')
  const post = (tenant: string, body: string, h: Record<string, string>) => firstParty.POST(req(`https://dazl.test/api/hooks/first-party?u=${tenant}`, body, h))
  const signed = (secret: string, body: string, ts = nowS()) => ({ 'x-dazl-timestamp': String(ts), 'x-dazl-signature': signBody(secret, ts, body) })
  const body = JSON.stringify({ events: [{ id: 'evt-1', type: 'demo_request', occurred_at: new Date().toISOString(), page_url: 'https://seller.test/demo', consent: 'granted', person: { email: 'pat@acme.io', name: 'Pat' } }] })
  const stored = () => n("SELECT COUNT(*) AS n FROM lead_enrichments WHERE connector = 'first_party'")
  const ts = nowS()
  const refusals: [string, Record<string, string>, string?][] = [
    ['unsigned', {}],
    ['timestamp only', { 'x-dazl-timestamp': String(ts) }],
    ['signature only', { 'x-dazl-signature': signBody(sa, ts, body) }],
    ['wrong secret', signed('wrong', body)],
    ["another tenant's secret", signed(sb, body)],
    ['tampered body', signed(sa, body), body.replace('Pat', 'Mallory')],
    ['signature over another timestamp', { 'x-dazl-timestamp': String(ts), 'x-dazl-signature': signBody(sa, ts - 1, body) }],
    ['stale', signed(sa, body, ts - 3600)],
    ['future', signed(sa, body, ts + 3600)],
  ]
  for (const [why, h, sent] of refusals) assert.equal((await post(A, sent ?? body, h)).status, 404, why)
  assert.equal((await post('nobody_fp', body, signed(sa, body))).status, 404, 'unknown tenant')
  assert.equal(stored(), 0)
  const h = signed(sa, body)
  const first = await post(A, body, h)
  assert.equal(first.status, 200); assert.deepEqual((await first.json()).counts, { created: 1 })
  for (const replay of [h, signed(sa, body, ts - 1)]) { // the exact captured request, and a re-signed copy
    const r = await post(A, body, replay)
    assert.equal(r.status, 200); assert.deepEqual((await r.json()).counts, { duplicate: 1 })
  }
  assert.equal(stored(), 1, 'one event, stored once')
})

test('Stripe: t.body HMAC within 300s; refusals are 400 and record nothing; a signed replay answers duplicate', async () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET!
  const sign = (body: string, t = nowS(), s = secret) => `t=${t},v1=${hmac(s, `${t}.${body}`)}`
  const post = (body: string, sig?: string) => stripe.POST(req('https://dazl.test/api/billing/webhook', body, sig === undefined ? {} : { 'stripe-signature': sig }))
  const body = JSON.stringify({ id: 'evt_guard_1', type: 'invoice.created', data: { object: { id: 'in_guard', customer: 'cus_guard_none' } } })
  const events = () => n('SELECT COUNT(*) AS n FROM stripe_events')
  const t = nowS()
  const refusals: [string, string | undefined, string?][] = [
    ['unsigned', undefined],
    ['no v1', `t=${t}`],
    ['no t', `v1=${hmac(secret, `${t}.${body}`)}`],
    ['wrong secret', sign(body, t, 'whsec_wrong')],
    ['tampered body', sign(body, t), body.replace('in_guard', 'in_other')],
    ['signature over another t', `t=${t},v1=${hmac(secret, `${t - 1}.${body}`)}`],
    ['stale', sign(body, t - 301)],
    ['future', sign(body, t + 301)],
  ]
  for (const [why, sig, sent] of refusals) assert.equal((await post(sent ?? body, sig)).status, 400, why)
  assert.equal(events(), 0)
  const sig = sign(body, t)
  const first = await post(body, sig)
  assert.equal(first.status, 200); assert.notEqual((await first.json()).result, 'duplicate')
  for (const replay of [sig, sign(body, t - 1), `${sig},v1=${'0'.repeat(64)}`]) {
    const r = await post(body, replay)
    assert.equal(r.status, 200); assert.equal((await r.json()).result, 'duplicate')
  }
  assert.equal(events(), 1, 'recorded once')
})
