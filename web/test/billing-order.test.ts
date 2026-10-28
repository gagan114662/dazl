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
})

bothEngines('out of order without ending: a delayed older "unpaid" never undoes a later recovery, and the reverse', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 300, 'sub_1', 'cus_t', 'unpaid')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')), 'stale')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e5', 'customer.subscription.updated', 500, 'sub_1', 'cus_t', 'active')), 'applied') // paid: back to Pro
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 400, 'sub_1', 'cus_t', 'unpaid')), 'stale')
  assert.equal(await readPlan(db, T), 'pro')
  // two non-ending events of the same second apply in arrival order (documented; Stripe's next invoice event settles it)
  assert.equal(await applyStripeEvent(db, sub('e6', 'customer.subscription.updated', 500, 'sub_1', 'cus_t', 'unpaid')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
})

// Review repro: created is in whole seconds, so a delayed "active" of the SAME second as the cancellation must not
// bring Pro back. An ended subscription stays ended whatever the timestamps say.
bothEngines('same second: deleted then a delayed "active" of that second stays Free; the opposite order ends Free too', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.deleted', 200, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')), 'stale')
  assert.equal(await readPlan(db, T), 'free')
  // even a later-stamped "active" for the ended subscription (clock skew, a retried old payload) stays refused
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 250, 'sub_1', 'cus_t', 'active')), 'stale')
  assert.equal(await readPlan(db, T), 'free')
  // opposite order, same second: active first, then the end
  await applyStripeEvent(db, checkout('u1', 100, U, 'cus_u', 'sub_u'))
  assert.equal(await applyStripeEvent(db, sub('u2', 'customer.subscription.updated', 200, 'sub_u', 'cus_u', 'active')), 'applied')
  assert.equal(await applyStripeEvent(db, sub('u3', 'customer.subscription.deleted', 200, 'sub_u', 'cus_u', 'canceled')), 'applied')
  assert.equal(await readPlan(db, U), 'free')
})

bothEngines('same second: a "canceled" status update ends the subscription just like deleted', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')), 'stale')
  assert.equal(await readPlan(db, T), 'free')
})

bothEngines('resubscribe in the same second as the old end: the new subscription is Pro; the old one cannot undo it or come back', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.deleted', 200, 'sub_1', 'cus_t', 'canceled')), 'applied')
  assert.equal(await applyStripeEvent(db, checkout('e3', 200, T, 'cus_t', 'sub_2')), 'applied')
  assert.equal(await readPlan(db, T), 'pro')
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')), 'stale')
  assert.equal(await applyStripeEvent(db, sub('e5', 'customer.subscription.deleted', 200, 'sub_1', 'cus_t', 'canceled')), 'ignored') // a second end of the old one
  assert.equal(await readPlan(db, T), 'pro')
  assert.equal(await applyStripeEvent(db, sub('e6', 'customer.subscription.deleted', 210, 'sub_2', 'cus_t', 'canceled')), 'applied')
  assert.equal(await readPlan(db, T), 'free')
})

// Concurrency: events for one tenant processed at the same moment (two webhook deliveries in flight) are ordered by the
// rules above, not by which transaction commits last. On Postgres the plan row is locked before the checks.
bothEngines('concurrent deliveries for one tenant end in the state the rules give, whichever commits first', async ({ db }) => {
  const tenants = Array.from({ length: 12 }, (_, i) => String(i).padStart(32, 'c'))
  await Promise.all(tenants.map(t => applyStripeEvent(db, checkout(`co-${t}`, 100, t, `cus-${t}`, `sub-${t}`))))
  await Promise.all(tenants.flatMap(t => [
    applyStripeEvent(db, sub(`end-${t}`, 'customer.subscription.deleted', 200, `sub-${t}`, `cus-${t}`, 'canceled')),
    applyStripeEvent(db, sub(`act-${t}`, 'customer.subscription.updated', 200, `sub-${t}`, `cus-${t}`, 'active')),
  ]))
  for (const t of tenants) assert.equal(await readPlan(db, t), 'free', t) // ended stays ended, either commit order
  const u = tenants.map(t => t.replace(/^c+/, m => 'd'.repeat(m.length)))
  await Promise.all(u.map(t => applyStripeEvent(db, checkout(`co-${t}`, 100, t, `cus-${t}`, `sub-${t}`))))
  await Promise.all(u.flatMap(t => [
    applyStripeEvent(db, sub(`new-${t}`, 'customer.subscription.updated', 300, `sub-${t}`, `cus-${t}`, 'active')),
    applyStripeEvent(db, sub(`old-${t}`, 'customer.subscription.updated', 250, `sub-${t}`, `cus-${t}`, 'unpaid')),
  ]))
  for (const t of u) assert.equal(await readPlan(db, t), 'pro', t) // the newer event wins, either commit order
}, { pgMax: 8 })

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
