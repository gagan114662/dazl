import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { applyStripeEvent, migrateBilling, verifyStripeSignature, type StripeEvent } from '../lib/billing/stripe.ts'
import { getPlan, migratePlans } from '../lib/plans.ts'

const secret = 'whsec_test_secret'
const sign = (payload: string, t: number, s = secret) => `t=${t},v1=${createHmac('sha256', s).update(`${t}.${payload}`).digest('hex')}`

function setup() {
  const db = new Database(':memory:')
  migratePlans(db); migrateBilling(db)
  return db
}
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

test('checkout completed upgrades the tenant to pro and stores ids; replay is a duplicate', () => {
  const db = setup()
  assert.equal(getPlan(db, 'u1'), 'free')
  assert.equal(applyStripeEvent(db, checkout('evt_1', 'u1')), 'applied')
  assert.equal(getPlan(db, 'u1'), 'pro')
  assert.equal(getPlan(db, 'u2'), 'free')
  assert.equal(applyStripeEvent(db, checkout('evt_1', 'u1')), 'duplicate')
  const row = db.prepare('SELECT stripe_customer_id, stripe_subscription_id FROM tenant_plans WHERE tenant_id = ?').get('u1')
  assert.deepEqual({ ...(row as object) }, { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' })
})

test('subscription deleted or canceled downgrades; found by customer id; past_due keeps pro', () => {
  const db = setup()
  applyStripeEvent(db, checkout('evt_1', 'u1'))
  const sub = (id: string, status: string): StripeEvent => ({ id, type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status } } })
  applyStripeEvent(db, sub('evt_2', 'past_due'))
  assert.equal(getPlan(db, 'u1'), 'pro')
  applyStripeEvent(db, sub('evt_3', 'canceled'))
  assert.equal(getPlan(db, 'u1'), 'free')
  applyStripeEvent(db, sub('evt_4', 'active'))
  assert.equal(getPlan(db, 'u1'), 'pro')
  applyStripeEvent(db, { id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } })
  assert.equal(getPlan(db, 'u1'), 'free')
})

test('unknown tenant, unknown type and non-subscription checkout are ignored', () => {
  const db = setup()
  assert.equal(applyStripeEvent(db, checkout('evt_1', 'ghost')) , 'applied') // client_reference_id present: creates the row for that id
  assert.equal(applyStripeEvent(db, { id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_unknown' } } }), 'ignored')
  assert.equal(applyStripeEvent(db, { id: 'evt_3', type: 'invoice.paid', data: { object: { client_reference_id: 'u1' } } }), 'ignored')
  assert.equal(applyStripeEvent(db, { id: 'evt_4', type: 'checkout.session.completed', data: { object: { mode: 'payment', client_reference_id: 'u9' } } }), 'ignored')
  assert.equal(getPlan(db, 'u9'), 'free')
})
