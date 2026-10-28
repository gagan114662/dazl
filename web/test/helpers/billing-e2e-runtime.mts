// Stripe end to end, test mode, through the real route handlers (docs/PLATFORM.md step 5):
// checkout -> signed webhook (checkout.session.completed) -> Pro -> portal -> cancel at period end (still Pro) ->
// subscription deleted -> Free -> a late, older event and an old subscription's cancellation change nothing. Webhook bodies are Stripe-shaped fixture events (test/fixtures/stripe/*.json) signed
// with a test webhook secret exactly as Stripe signs them. Calls to api.stripe.com are answered by a stub that records
// them, so nothing reaches Stripe and nothing is charged. Runs under tenant-route-loader.mjs (signed-in user stubbed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture_pro'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.PUBLIC_BASE_URL = 'https://dazl.test'

const { getDb } = await import('../../lib/db/client.ts') // the real store the billing routes use
const { getAuthDb } = await import('../../lib/auth-db.ts')
const checkout = await import('../../app/api/billing/checkout/route.ts')
const portal = await import('../../app/api/billing/portal/route.ts')
const webhook = await import('../../app/api/billing/webhook/route.ts')
const usage = await import('../../app/api/usage/route.ts')

const stripeCalls: { path: string; form: URLSearchParams; auth: string | null }[] = []
const statusReads: string[] = [] // GET /v1/subscriptions/:id (read only; answered from subscriptionNow)
let subscriptionNow = 'active'
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input))
  if (u.hostname !== 'api.stripe.com') throw new Error(`Unexpected network call to ${u.hostname}`)
  if ((init?.method ?? 'GET') === 'GET' && u.pathname.startsWith('/v1/subscriptions/')) {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk_test_fixture')
    statusReads.push(u.pathname)
    if (subscriptionNow === 'down') return new Response('{}', { status: 503 })
    return new Response(JSON.stringify({ id: u.pathname.split('/').pop(), status: subscriptionNow }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const form = new URLSearchParams(String(init?.body ?? ''))
  stripeCalls.push({ path: u.pathname, form, auth: new Headers(init?.headers).get('authorization') })
  const url = u.pathname.endsWith('/checkout/sessions') ? 'https://checkout.stripe.test/c/pay/cs_test_fixture' : 'https://billing.stripe.test/p/session/bps_fixture'
  return new Response(JSON.stringify({ id: 'fixture', url }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const fixture = (name: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
// Stripe-Signature: t=<unix seconds>,v1=HMAC-SHA256(secret, "<t>.<raw body>")
const sign = (body: string, secret = process.env.STRIPE_WEBHOOK_SECRET!, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const deliver = (body: string, signature: string | null) => webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) } }))
const json = (path: string, body: unknown = {}) => new NextRequest(`https://dazl.test${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } })
const plan = async () => (await (await usage.GET(new NextRequest('https://dazl.test/api/usage')))!.json()) as { plan: string; scan_limit: number | null }

test('Stripe test mode end to end: checkout, signed webhook, Pro, portal, cancel, downgrade to Free', async () => {
  await getDb() // opens and migrates the store at DB_PATH (a throwaway file under the test fence)
  setScanDb(getAuthDb()) // /api/usage (getScanDb) reads the same store the billing routes write
  const T = 'tenant' + randomBytes(6).toString('hex')
  const other = 'other' + randomBytes(6).toString('hex')
  setUser({ id: T, business_name: 'Acme' } as never)
  const vars = { TENANT: T, CUSTOMER: 'cus_fixture' + randomBytes(4).toString('hex'), SUBSCRIPTION: 'sub_fixture' + randomBytes(4).toString('hex') }

  // 0. Free to start: 50 scans a month
  assert.deepEqual(await plan(), { ...(await plan()), plan: 'free', scan_limit: 50 })

  // 1. Checkout: one Stripe call, test key, the Pro price, the tenant as client_reference_id and subscription metadata
  const co = await checkout.POST(json('/api/billing/checkout'))
  assert.equal(co.status, 200)
  assert.equal((await co.json()).url, 'https://checkout.stripe.test/c/pay/cs_test_fixture')
  assert.equal(stripeCalls.length, 1)
  const c0 = stripeCalls[0]
  assert.equal(c0.path, '/v1/checkout/sessions')
  assert.equal(c0.auth, 'Bearer sk_test_fixture')
  assert.equal(c0.form.get('mode'), 'subscription')
  assert.equal(c0.form.get('line_items[0][price]'), 'price_fixture_pro')
  assert.equal(c0.form.get('client_reference_id'), T)
  assert.equal(c0.form.get('subscription_data[metadata][tenant_id]'), T)
  assert.equal(c0.form.get('success_url'), 'https://dazl.test/app/settings?billing=success')
  // still Free: paying happens on Stripe's page, only the webhook upgrades
  assert.equal((await plan()).plan, 'free')
  // no portal before a customer exists
  assert.equal((await portal.POST(json('/api/billing/portal'))).status, 404)

  // 2. Webhook: an unsigned, a wrongly signed and a stale-signed delivery are all refused and change nothing
  const completed = fixture('checkout.session.completed', vars)
  assert.equal((await deliver(completed, null)).status, 400)
  assert.equal((await deliver(completed, sign(completed, 'whsec_wrong'))).status, 400)
  assert.equal((await deliver(completed, sign(completed, undefined, Math.floor(Date.now() / 1000) - 3600))).status, 400)
  assert.equal((await deliver(completed + ' ', sign(completed))).status, 400) // body changed after signing
  assert.equal((await plan()).plan, 'free')

  // 3. The signed event upgrades the tenant to Pro (unlimited); a replay is a duplicate
  const ok = await deliver(completed, sign(completed))
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { result: 'applied' })
  assert.deepEqual(await plan(), { ...(await plan()), plan: 'pro', scan_limit: null })
  assert.deepEqual(await (await deliver(completed, sign(completed))).json(), { result: 'duplicate' })
  // a second checkout is refused: already Pro, no Stripe call
  assert.equal((await checkout.POST(json('/api/billing/checkout'))).status, 409)
  assert.equal(stripeCalls.length, 1)

  // 4. Portal: opens for the stored customer, returning to Settings
  const po = await portal.POST(json('/api/billing/portal'))
  assert.equal(po.status, 200)
  assert.equal((await po.json()).url, 'https://billing.stripe.test/p/session/bps_fixture')
  assert.equal(stripeCalls[1].path, '/v1/billing_portal/sessions')
  assert.equal(stripeCalls[1].form.get('customer'), vars.CUSTOMER)
  assert.equal(stripeCalls[1].form.get('return_url'), 'https://dazl.test/app/settings')

  // 5. Cancel in the portal = cancel at period end: Stripe sends subscription.updated, still active, so still Pro
  const cancelAtEnd = fixture('customer.subscription.updated.cancel_at_period_end', vars)
  assert.deepEqual(await (await deliver(cancelAtEnd, sign(cancelAtEnd))).json(), { result: 'applied' })
  assert.equal((await plan()).plan, 'pro')

  // 6. Period ends: subscription.deleted downgrades to Free (50 a month); found by customer id, no tenant in the event
  const deleted = fixture('customer.subscription.deleted', vars)
  assert.deepEqual(await (await deliver(deleted, sign(deleted))).json(), { result: 'applied' })
  assert.deepEqual(await plan(), { ...(await plan()), plan: 'free', scan_limit: 50 })

  // 6b. Stripe does not deliver in order: a signed subscription.updated (still active) created before the deletion but
  // delivered after it is stale and does not bring Pro back
  const late = cancelAtEnd.replace(/"id": "evt_[^"]+"/, '"id": "evt_test_late_update"')
  assert.deepEqual(await (await deliver(late, sign(late))).json(), { result: 'stale' })
  assert.equal((await plan()).plan, 'free')

  // 7. An event for another tenant's customer never touches this tenant
  const foreign = fixture('checkout.session.completed', { ...vars, TENANT: other, CUSTOMER: 'cus_other', SUBSCRIPTION: 'sub_other' })
    .replace(/"id": "evt_[^"]+"/, '"id": "evt_other_fixture"')
  await deliver(foreign, sign(foreign))
  assert.equal((await plan()).plan, 'free')

  // 8. After the downgrade the tenant can check out again (a new Stripe session)
  assert.equal((await checkout.POST(json('/api/billing/checkout'))).status, 200)
  assert.equal(stripeCalls.at(-1)!.form.get('customer'), vars.CUSTOMER) // reuses the existing customer

  // 9. The tenant subscribes again (a new subscription); the old subscription's late cancellation does not cancel it
  const NEW_SUB = 'sub_fixture_new' + randomBytes(4).toString('hex')
  const resub = fixture('checkout.session.completed', { ...vars, SUBSCRIPTION: NEW_SUB })
    .replace(/"id": "evt_[^"]+"/, '"id": "evt_test_resubscribe"').replace(/"created": \d+/, '"created": 1793000300')
  assert.deepEqual(await (await deliver(resub, sign(resub))).json(), { result: 'applied' })
  assert.equal((await plan()).plan, 'pro')
  const oldEnds = deleted.replace(/"id": "evt_[^"]+"/, '"id": "evt_test_old_sub_ends"').replace(/"created": \d+/, '"created": 1793000400')
  assert.deepEqual(await (await deliver(oldEnds, sign(oldEnds))).json(), { result: 'ignored' })
  assert.equal((await plan()).plan, 'pro')

  // 10. Two updates of the new subscription in the same second (unpaid, then a delayed active): the webhook reads the
  // subscription's status from Stripe (stubbed GET, test key, no charge) instead of trusting delivery order
  const upd = (id: string, status: string) => cancelAtEnd.replace(/"id": "evt_[^"]+"/, `"id": "${id}"`).replace(/"created": \d+/, '"created": 1793000500')
    .replace(`"id": "${vars.SUBSCRIPTION}"`, `"id": "${NEW_SUB}"`).replace('"status": "active"', `"status": "${status}"`)
  const unpaid = upd('evt_test_unpaid', 'unpaid'), active = upd('evt_test_late_active', 'active')
  assert.deepEqual(await (await deliver(unpaid, sign(unpaid))).json(), { result: 'applied' })
  assert.equal((await plan()).plan, 'free')
  subscriptionNow = 'unpaid'
  assert.deepEqual(await (await deliver(active, sign(active))).json(), { result: 'reconciled' })
  assert.equal((await plan()).plan, 'free') // Stripe says unpaid: delivery order did not decide
  assert.deepEqual(statusReads, [`/v1/subscriptions/${NEW_SUB}`])

  // 11. Reverse order (active, then a delayed unpaid of the same second) while Stripe cannot be read: the webhook
  // applies the restrictive state, answers 503 and leaves the event unprocessed; the redelivery is settled by the read
  const upd2 = (id: string, status: string) => upd(id, status).replace(/"created": \d+/, '"created": 1793000600')
  const active2 = upd2('evt_test_active2', 'active'), unpaid2 = upd2('evt_test_unpaid2', 'unpaid')
  assert.deepEqual(await (await deliver(active2, sign(active2))).json(), { result: 'applied' })
  assert.equal((await plan()).plan, 'pro')
  subscriptionNow = 'down'
  const held = await deliver(unpaid2, sign(unpaid2))
  assert.equal(held.status, 503)
  assert.deepEqual(await held.json(), { result: 'held' })
  assert.equal((await plan()).plan, 'free')
  subscriptionNow = 'active'
  assert.deepEqual(await (await deliver(unpaid2, sign(unpaid2))).json(), { result: 'reconciled' }) // Stripe's redelivery
  assert.equal((await plan()).plan, 'pro')
  console.log('STRIPE_E2E', stripeCalls.length)
})
