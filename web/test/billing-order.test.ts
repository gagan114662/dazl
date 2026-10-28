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

// Review repro: two non-ending events of the same second (unpaid, active) cannot be ordered by created. The plan comes
// from the subscription's current status at Stripe (stubbed here; no network, no charge), never from delivery order.
const stripeSays = (status: string, calls: string[] = []) => ({ calls, subscriptionStatus: async (id: string) => { calls.push(id); return status } })
const never = { subscriptionStatus: async (): Promise<string> => { throw new Error('must not ask Stripe') } }

bothEngines('same-second tie, unpaid then active: the plan is what Stripe says now, in either answer', async ({ db }) => {
  for (const [tenant, now, plan] of [[T, 'unpaid', 'free'], [U, 'active', 'pro']] as const) {
    await applyStripeEvent(db, checkout(`co-${tenant}`, 100, tenant, `cus-${tenant}`, `sub-${tenant}`))
    assert.equal(await applyStripeEvent(db, sub(`unpaid-${tenant}`, 'customer.subscription.updated', 200, `sub-${tenant}`, `cus-${tenant}`, 'unpaid'), never), 'applied') // not a tie: newer
    const s = stripeSays(now)
    assert.equal(await applyStripeEvent(db, sub(`active-${tenant}`, 'customer.subscription.updated', 200, `sub-${tenant}`, `cus-${tenant}`, 'active'), s), 'reconciled')
    assert.deepEqual(s.calls, [`sub-${tenant}`])
    assert.equal(await readPlan(db, tenant), plan)
  }
})

bothEngines('same-second tie, active then unpaid (the reverse order): the plan is what Stripe says now, in either answer', async ({ db }) => {
  for (const [tenant, now, plan] of [[T, 'active', 'pro'], [U, 'unpaid', 'free']] as const) {
    await applyStripeEvent(db, checkout(`co-${tenant}`, 100, tenant, `cus-${tenant}`, `sub-${tenant}`))
    assert.equal(await applyStripeEvent(db, sub(`active-${tenant}`, 'customer.subscription.updated', 200, `sub-${tenant}`, `cus-${tenant}`, 'active'), never), 'applied')
    assert.equal(await applyStripeEvent(db, sub(`unpaid-${tenant}`, 'customer.subscription.updated', 200, `sub-${tenant}`, `cus-${tenant}`, 'unpaid'), stripeSays(now)), 'reconciled')
    assert.equal(await readPlan(db, tenant), plan)
  }
})

bothEngines('tie without an answer from Stripe: restrictive (Free) at once, event left unprocessed, redelivery settles it', async ({ db }) => {
  // review sequence: unpaid, then a delayed active of the same second, and Stripe cannot be read
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'unpaid'))
  const tie = sub('e3', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active')
  const down = { subscriptionStatus: async (): Promise<string> => { throw new Error('stripe_503') } }
  assert.equal(await applyStripeEvent(db, tie, down), 'held')
  assert.equal(await readPlan(db, T), 'free') // not Pro
  assert.equal(await db.get("SELECT 1 AS x FROM stripe_events WHERE id = 'e3'"), undefined) // not marked processed: Stripe redelivers
  assert.equal(await applyStripeEvent(db, tie, stripeSays('active')), 'reconciled') // redelivery, Stripe answers: paid
  assert.equal(await readPlan(db, T), 'pro')
  // reverse order (active, then a delayed unpaid of the same second), Stripe cannot be read: restrictive at once
  await applyStripeEvent(db, checkout('u1', 100, U, 'cus_u', 'sub_u'))
  await applyStripeEvent(db, sub('u2', 'customer.subscription.updated', 200, 'sub_u', 'cus_u', 'active'))
  const late = sub('u3', 'customer.subscription.updated', 200, 'sub_u', 'cus_u', 'unpaid')
  assert.equal(await applyStripeEvent(db, late, down), 'held')
  assert.equal(await readPlan(db, U), 'free')
  // the redelivery is still settled by Stripe's answer, though the plan already reads Free
  assert.equal(await applyStripeEvent(db, late, stripeSays('active')), 'reconciled')
  assert.equal(await readPlan(db, U), 'pro')
  // and a settled second is not asked again
  assert.equal(await applyStripeEvent(db, sub('u4', 'customer.subscription.updated', 200, 'sub_u', 'cus_u', 'active'), never), 'applied')
})

bothEngines('no question to Stripe when the same-second event would not change the plan, or is not a tie', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 100, 'sub_1', 'cus_t', 'active'), never), 'applied') // same second, same plan
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 300, 'sub_1', 'cus_t', 'unpaid'), never), 'applied') // newer
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 250, 'sub_1', 'cus_t', 'active'), never), 'stale') // older
  assert.equal(await readPlan(db, T), 'free')
})

bothEngines('tie: Stripe saying the subscription has ended ends it for good', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'unpaid'))
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'active'), stripeSays('canceled')), 'reconciled')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 300, 'sub_1', 'cus_t', 'active'), never), 'stale') // ended stays ended
})

// Both deliveries of a same-second pair in flight at once: whichever commits first, the other one is either settled
// by Stripe's answer or held (restrictive, left unprocessed) and settled on redelivery. Never by commit order.
bothEngines('concurrent same-second pair: the end state is what Stripe says, whatever the commit order', async ({ db }) => {
  const tenants = Array.from({ length: 10 }, (_, i) => String(i).padStart(32, 'e'))
  await Promise.all(tenants.map(t => applyStripeEvent(db, checkout(`co-${t}`, 100, t, `cus-${t}`, `sub-${t}`))))
  const deliver = async (ev: StripeEvent) => {
    for (let i = 0; i < 6; i++) {
      const r = await applyStripeEvent(db, ev, stripeSays('unpaid'))
      if (r !== 'held') return r // held: Stripe redelivers
    }
    throw new Error('never settled')
  }
  await Promise.all(tenants.flatMap(t => [
    deliver(sub(`u-${t}`, 'customer.subscription.updated', 200, `sub-${t}`, `cus-${t}`, 'unpaid')),
    deliver(sub(`a-${t}`, 'customer.subscription.updated', 200, `sub-${t}`, `cus-${t}`, 'active')),
  ]))
  for (const t of tenants) assert.equal(await readPlan(db, t), 'free', t)
}, { pgMax: 8 })

// Review repro (4ca4b5c): an answer from Stripe the policy does not map must never leave Pro in place. Known
// non-entitling statuses settle to Free; unknown ones hold (restrictive, event unprocessed, redelivered) until Stripe
// answers with a status the policy knows.
bothEngines('tie: Stripe answering incomplete or paused settles to Free; an unknown status holds restrictively and retries', async ({ db }) => {
  // checkout @100 -> same-second unpaid @100, Stripe says "incomplete"
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 100, 'sub_1', 'cus_t', 'unpaid'), stripeSays('incomplete')), 'reconciled')
  assert.equal(await readPlan(db, T), 'free')
  // same with "paused"
  await applyStripeEvent(db, checkout('p1', 100, U, 'cus_u', 'sub_u'))
  assert.equal(await applyStripeEvent(db, sub('p2', 'customer.subscription.updated', 100, 'sub_u', 'cus_u', 'unpaid'), stripeSays('paused')), 'reconciled')
  assert.equal(await readPlan(db, U), 'free')
  // a status Stripe may add later: held, not ignored and final
  const V = 'f'.repeat(32)
  await applyStripeEvent(db, checkout('v1', 100, V, 'cus_v', 'sub_v'))
  const tie = sub('v2', 'customer.subscription.updated', 100, 'sub_v', 'cus_v', 'unpaid')
  assert.equal(await applyStripeEvent(db, tie, stripeSays('some_new_status')), 'held')
  assert.equal(await readPlan(db, V), 'free')
  assert.equal(await db.get("SELECT 1 AS x FROM stripe_events WHERE id = 'v2'"), undefined) // not processed
  // after a held tie: the redelivery with an unknown answer holds again; a known answer settles it
  assert.equal(await applyStripeEvent(db, tie, stripeSays('another_new_status')), 'held')
  assert.equal(await readPlan(db, V), 'free')
  assert.equal(await applyStripeEvent(db, tie, stripeSays('active')), 'reconciled')
  assert.equal(await readPlan(db, V), 'pro')
  assert.ok(await db.get("SELECT 1 AS x FROM stripe_events WHERE id = 'v2'"))
})

bothEngines('status policy outside ties: paused and incomplete downgrade (recoverable); an unknown status changes nothing', async ({ db }) => {
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'paused'), never), 'applied')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 300, 'sub_1', 'cus_t', 'active'), never), 'applied') // resumed
  assert.equal(await readPlan(db, T), 'pro')
  assert.equal(await applyStripeEvent(db, sub('e4', 'customer.subscription.updated', 400, 'sub_1', 'cus_t', 'incomplete'), never), 'applied')
  assert.equal(await readPlan(db, T), 'free')
  assert.equal(await applyStripeEvent(db, sub('e5', 'customer.subscription.updated', 500, 'sub_1', 'cus_t', 'some_new_status'), never), 'ignored')
  assert.equal(await readPlan(db, T), 'free') // unknown never grants anything
})

// The subscription status Stripe last reported is kept beside the plan (tenant_plans.subscription_status): past_due
// after a failed payment while Stripe retries keeps Pro; a stale event never rewrites it; a settled tie stores Stripe's
// answer.
bothEngines('subscription status: past_due keeps Pro, a stale event never rewrites it, a settled tie stores Stripe\'s answer', async ({ db }) => {
  const status = async (t: string) => (await db.get<{ s: string | null }>('SELECT subscription_status AS s FROM tenant_plans WHERE tenant_id = ?', [t]))?.s ?? null
  await applyStripeEvent(db, checkout('e1', 100, T, 'cus_t', 'sub_1'))
  assert.equal(await status(T), 'active')
  assert.equal(await applyStripeEvent(db, sub('e2', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'past_due'), never), 'applied')
  assert.deepEqual([await readPlan(db, T), await status(T)], ['pro', 'past_due'])
  assert.equal(await applyStripeEvent(db, sub('e0', 'customer.subscription.updated', 150, 'sub_1', 'cus_t', 'active'), never), 'stale')
  assert.equal(await status(T), 'past_due')
  // same-second tie (past_due @200 vs unpaid @200): Stripe says unpaid
  assert.equal(await applyStripeEvent(db, sub('e3', 'customer.subscription.updated', 200, 'sub_1', 'cus_t', 'unpaid'), stripeSays('unpaid')), 'reconciled')
  assert.deepEqual([await readPlan(db, T), await status(T)], ['free', 'unpaid'])
  await applyStripeEvent(db, sub('e4', 'customer.subscription.deleted', 300, 'sub_1', 'cus_t', 'canceled'))
  assert.deepEqual([await readPlan(db, T), await status(T)], ['free', 'canceled'])
  assert.equal(await status(U), null) // another tenant untouched
})
