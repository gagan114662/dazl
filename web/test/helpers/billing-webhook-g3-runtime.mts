// #2020 gate G3 (lane C): the Stripe webhook ROUTE seam of app/api/billing/webhook/route.ts itself (the
// /api/stripe alias re-exports this same POST and is covered end-to-end by test/stripe-endpoint.test.ts; this
// runtime pins the route-level decisions that suite does not exercise):
//   - with no STRIPE_WEBHOOK_SECRET the endpoint is off (503) and nothing is recorded;
//   - an unsigned, wrongly-signed or stale-timestamp delivery is refused 400 BEFORE any state changes;
//   - a validly signed body that is not a usable event (not JSON, or JSON without id/type) is refused 400;
//   - the control: a validly signed checkout event applies exactly once through this route, and its replay
//     answers 'duplicate' with still exactly one stripe_events row - so the refusals above are the signature
//     and payload checks deciding, not a harness that can never apply anything.
// Stripe is never reached: the event needs no subscription-status read (no prior plan row, so no tie), and the
// fixture tenant has no user row, so the #417 conversion block reads an unknown account and writes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, getScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const SECRET = 'whsec_g3_fixture'
process.env.STRIPE_WEBHOOK_SECRET = SECRET

const webhook = await import('../../app/api/billing/webhook/route.ts')

const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const post = (body: string, signature: string | null) => webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
}))
const counts = () => {
  const raw = getScanDb()
  const n = (t: string) => (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
  return { events: n('stripe_events'), plans: n('tenant_plans') }
}

test('G3 webhook route: refusals change nothing, a valid event applies exactly once', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  setScanDb(raw)
  const tenant = 'g3-' + randomBytes(6).toString('hex')
  const event = JSON.stringify({
    id: 'evt_g3_' + randomBytes(6).toString('hex'), type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { mode: 'subscription', client_reference_id: tenant, customer: 'cus_g3', subscription: 'sub_g3' } },
  })

  // Endpoint off: no webhook secret configured -> 503, and the delivery records nothing.
  delete process.env.STRIPE_WEBHOOK_SECRET
  assert.equal((await post(event, sign(event))).status, 503)
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  assert.deepEqual(counts(), { events: 0, plans: 0 }, 'a delivery while the endpoint is off records nothing')

  // Signature gate: unsigned, wrong secret, body tampered after signing, and a stale timestamp (replay window)
  // are all refused 400 before any state changes.
  assert.equal((await post(event, null)).status, 400, 'unsigned')
  assert.equal((await post(event, sign(event, Math.floor(Date.now() / 1000), 'whsec_other'))).status, 400, 'wrong secret')
  assert.equal((await post(event + ' ', sign(event))).status, 400, 'tampered body')
  assert.equal((await post(event, sign(event, Math.floor(Date.now() / 1000) - 3600))).status, 400, 'stale timestamp')
  assert.deepEqual(counts(), { events: 0, plans: 0 }, 'refused deliveries change nothing')

  // Payload gate: validly signed but unusable bodies are refused 400 too.
  const notJson = 'this is not json'
  assert.equal((await post(notJson, sign(notJson))).status, 400, 'signed non-JSON body')
  const noId = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } })
  assert.equal((await post(noId, sign(noId))).status, 400, 'signed JSON without an event id')
  assert.deepEqual(counts(), { events: 0, plans: 0 }, 'unusable payloads change nothing')

  // Control: the same harness CAN apply an event - once. The replay is a duplicate and adds no second row.
  const first = await post(event, sign(event))
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { result: 'applied' })
  assert.equal((raw.prepare('SELECT plan FROM tenant_plans WHERE tenant_id = ?').get(tenant) as { plan: string }).plan, 'pro')
  const replay = await post(event, sign(event))
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), { result: 'duplicate' })
  assert.deepEqual(counts(), { events: 1, plans: 1 }, 'the replay records no second event and changes no plan')

  console.log('BILLING_WEBHOOK_G3 sqlite')
})
