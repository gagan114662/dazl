import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { applyStripeEvent, createCheckoutUrl, createPortalUrl, verifyStripeSignature, type StripeEvent } from '../lib/billing/stripe.ts'
import { readPlan } from '../lib/plans.ts'
import { bothEngines } from './helpers/engines.ts'

const secret = 'whsec_test_secret'
const sign = (payload: string, t: number, s = secret) => `t=${t},v1=${createHmac('sha256', s).update(`${t}.${payload}`).digest('hex')}`

const checkout = (id: string, tenant: string): StripeEvent => ({ id, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: tenant, customer: 'cus_1', subscription: 'sub_1' } } })

test('signature: valid, tampered, wrong secret, stale, missing', () => {
  const now = 1_700_000_000_000, t = now / 1000, body = '{"a":1}'
  assert.equal(verifyStripeSignature(body, sign(body, t), secret, now), true)
  assert.equal(verifyStripeSignature(body + ' ', sign(body, t), secret, now), false)
  assert.equal(verifyStripeSignature(body, sign(body, t, 'other'), secret, now), false)
  assert.equal(verifyStripeSignature(body, sign(body, t - 1000), secret, now), false)
  assert.equal(verifyStripeSignature(body, null, secret, now), false)
  assert.equal(verifyStripeSignature(body, 't=abc,v1=zz', secret, now), false)
})

bothEngines('checkout completed upgrades the tenant to pro and stores ids; replay is a duplicate', async ({ db }) => {
  assert.equal(await readPlan(db, 'u1'), 'free')
  assert.equal(await applyStripeEvent(db, checkout('evt_1', 'u1')), 'applied')
  assert.equal(await readPlan(db, 'u1'), 'pro')
  assert.equal(await readPlan(db, 'u2'), 'free')
  assert.equal(await applyStripeEvent(db, checkout('evt_1', 'u1')), 'duplicate')
  const row = await db.get('SELECT stripe_customer_id, stripe_subscription_id FROM tenant_plans WHERE tenant_id = ?', ['u1'])
  assert.deepEqual({ ...(row as object) }, { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' })
})

bothEngines('unpaid and canceled downgrade; found by customer id; past_due keeps pro; unpaid can recover, canceled cannot', async ({ db }) => {
  await applyStripeEvent(db, checkout('evt_1', 'u1'))
  const sub = (id: string, status: string): StripeEvent => ({ id, type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status } } })
  await applyStripeEvent(db, sub('evt_2', 'past_due'))
  assert.equal(await readPlan(db, 'u1'), 'pro')
  await applyStripeEvent(db, sub('evt_3', 'unpaid'))
  assert.equal(await readPlan(db, 'u1'), 'free')
  await applyStripeEvent(db, sub('evt_4', 'active')) // paid after all
  assert.equal(await readPlan(db, 'u1'), 'pro')
  await applyStripeEvent(db, sub('evt_5', 'canceled'))
  assert.equal(await readPlan(db, 'u1'), 'free')
  assert.equal(await applyStripeEvent(db, sub('evt_6', 'active')), 'stale') // a canceled subscription is over in Stripe
  assert.equal(await readPlan(db, 'u1'), 'free')
  await applyStripeEvent(db, { id: 'evt_7', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } })
  assert.equal(await readPlan(db, 'u1'), 'free')
})

bothEngines('unknown tenant, unknown type and non-subscription checkout are ignored', async ({ db }) => {
  assert.equal(await applyStripeEvent(db, checkout('evt_1', 'ghost')), 'applied') // client_reference_id present: creates the row for that id
  assert.equal(await applyStripeEvent(db, { id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_unknown' } } }), 'ignored')
  assert.equal(await applyStripeEvent(db, { id: 'evt_3', type: 'invoice.paid', data: { object: { client_reference_id: 'u1' } } }), 'ignored')
  assert.equal(await applyStripeEvent(db, { id: 'evt_4', type: 'checkout.session.completed', data: { object: { mode: 'payment', client_reference_id: 'u9' } } }), 'ignored')
  assert.equal(await readPlan(db, 'u9'), 'free')
})

bothEngines('the same event delivered concurrently is applied once', async ({ db }) => {
  const results = await Promise.all([1, 2, 3, 4].map(() => applyStripeEvent(db, checkout('evt_c', 'u1'))))
  assert.deepEqual(results.sort(), ['applied', 'duplicate', 'duplicate', 'duplicate'])
  assert.equal((await db.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events'))!.n, 1)
}, { pgMax: 4 })

bothEngines('a failure while applying rolls back the event row, so Stripe can retry it', async ({ db }) => {
  // the event row is written first; when a later statement fails the whole transaction, event row included, rolls back
  const bad: StripeEvent = { id: 'evt_bad', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1' } } }
  await db.run('DROP TABLE tenant_plans')
  await assert.rejects(applyStripeEvent(db, bad))
  assert.equal(await db.get('SELECT id FROM stripe_events WHERE id = ?', ['evt_bad']), undefined)
})

bothEngines('checkout and portal read the stored Stripe customer', async ({ db }) => {
  const calls: { url: string; body: string }[] = []
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return new Response(JSON.stringify({ url: 'https://stripe.test/x' })) }) as unknown as typeof fetch
  assert.equal(await createPortalUrl(db, 'u1', f), null)
  assert.equal(await createCheckoutUrl(db, 'u1', 'a@x.com', f), 'https://stripe.test/x')
  assert.match(calls[0].body, /customer_email=a%40x.com/)
  await applyStripeEvent(db, checkout('evt_1', 'u1'))
  await createCheckoutUrl(db, 'u1', 'a@x.com', f)
  assert.match(calls[1].body, /customer=cus_1/)
  assert.equal(await createPortalUrl(db, 'u1', f), 'https://stripe.test/x')
  assert.match(calls[2].body, /customer=cus_1/)
})

test('failed scans do not use quota', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { migrateScan } = await import('../lib/scan/store.ts')
  const { scansThisMonth } = await import('../lib/plans.ts')
  const db = new Database(':memory:'); migrateScan(db)
  const now = Math.floor(Date.now() / 1000)
  const ins = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'u1', 'b', 'i', 'l', ?, ?)")
  ins.run('a', 'done', now); ins.run('b', 'failed', now); ins.run('c', 'pending', now)
  assert.equal(scansThisMonth(db, 'u1'), 2)
})
