// Stripe does not deliver events in order or only once (docs/PLATFORM.md step 5). On both engines: an event created
// before the one that last set the plan is stale and changes nothing; an old subscription ending does not cancel a newer
// one; replays stay duplicates; and the normal order still upgrades and downgrades.
import assert from 'node:assert/strict'
import { applyStripeEvent, type StripeEvent } from '../lib/billing/stripe.ts'
import { readPlan } from '../lib/plans.ts'
import { bothEngines } from './helpers/engines.ts'

const T = 'a'.repeat(32), U = 'b'.repeat(32)
const ev = (id: string, type: string, created: number | undefined, object: StripeEvent['data']['object']): StripeEvent => ({ id, type, ...(created === undefined ? {} : { created }), data: { object } })
const checkout = (id: string, created: number, tenant: string, customer: string, sub: string) => ev(id, 'checkout.session.completed', created, { mode: 'subscription', client_reference_id: tenant, customer, subscription: sub })
const sub = (id: string, type: string, created: number | undefined, subId: string, customer: string, status: string) => ev(id, type, created, { id: subId, customer, status })

bothEngines('in order: checkout -> Pro, cancel at period end stays Pro, deleted -> Free', async ({ db }) => {
  assert.equal(await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1')), 'applied')
  assert.equal(await readPlan(db, T), 'pro')
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')), 'applied')
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.deleted', 300, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.deleted', 300, 'sub_1', 'cus_t', 'canceled')), 'duplicate')
})

bothEngines('out of order: a delayed older "active" never undoes a later cancellation', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.deleted', 300, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')), 'stale')
  assert.equal(await readPlan(db, T), 'free')
  // and the other way round: a delayed older cancellation never undoes a later reactivation
  await applyStripeEvent(db, sub('e5', 'customer.subscription.updated', 500, 'sub_1', 'cus_t', 'active'))
  assert.equal(await readPlan(db, T), 'pro')
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 400, 'sub_1', 'cus_t', 'unpaid')), 'stale')
  assert.equal(await readPlan(db, T), 'pro')
  // the same second applies in arrival order (Stripe's created is in seconds)
  assert.equal(await applyStripeEvent(db, sub('e6', 'customer.subscription.updated', 500, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
})

bothEngines("an old subscription ending does not cancel the tenant's current one", async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_old'))
  await applyStripeEvent(db, sub('e2', 'customer.subscription.deleted', 200, 'sub_old', 'cus_t', 'canceled'))
  assert.equal(await applyStripeEvent(db, checkout('e3', 300, T, 'cus_t', 'sub_new')), 'applied') // subscribes again
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 400, 'sub_old', 'cus_t', 'canceled')), 'ignored')
  assert.equal(await applyStripeEvent(db, sub('e5', 'customer.subscription.deleted', 410, 'sub_old', 'cus_t', 'canceled')), 'ignored')
  assert.equal(await readPlan(db, T), 'pro')
  // the current subscription ending does downgrade
  assert.equal(await applyStripeEvent(db, sub('e6', 'customer.subscription.deleted', 500, 'sub_new', 'cus_t', 'canceled')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
})

bothEngines("ordering is per tenant: one tenant's newer events never make another tenant's events stale", async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 900, T, 'cus_t', 'sub_t'))
  assert.equal(await applyStripeEvent(db, checkout('e2', 100, U, 'cus_u', 'sub_u')), 'applied')
  assert.equal(await readPlan(db, U), 'pro')
  assert.equal(await readPlan(db, T), 'pro')
})

bothEngines('an event without a created time still applies (and does not move the ordering mark)', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.deleted', undefined, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 50, 'sub_1', 'cus_t', 'active')), 'stale') // still older than 100
})
