// Stripe webhook events in test mode, through the real webhook route, with two tenants (test/billing-events.test.ts):
// checkout.session.completed, customer.subscription.updated, invoice.payment_failed and customer.subscription.deleted
// each change the right tenant's plan, limit and billing status in the store, are applied once per event id (also
// when Stripe delivers one event several times at once), are refused unsigned, and never change the other tenant's
// row. Bodies are Stripe-shaped fixtures (test/fixtures/stripe) signed with a test webhook secret as Stripe signs them.
// No call reaches Stripe: the only Stripe API read (a same-second tie) is answered by a stub, and any other outbound
// call fails the run. Runs on SQLite and, with DAZL_TEST_PG_URL, on a fresh Postgres schema with the SQLite handle
// trapped. Runs under tenant-route-loader.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { setScanDb, setUser, trapScanDb } from './tenant-route-db.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture_pro'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.PUBLIC_BASE_URL = 'https://dazl.test'

const { getDb, setDb, pgDb } = await import('../../lib/db/client.ts')
const { runPgMigrations } = await import('../../lib/db/migrate-pg.ts')
const { getAuthDb } = await import('../../lib/auth-db.ts')
const webhook = await import('../../app/api/billing/webhook/route.ts')
const usage = await import('../../app/api/usage/route.ts')

globalThis.fetch = (async (input: unknown) => { throw new Error(`Unexpected network call: ${String(input)}`) }) as typeof fetch

const fixture = (name: string, vars: Record<string, string>, over: { id?: string; created?: number } = {}) => {
  let s = Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
  if (over.id) s = s.replace(/"id": "evt_[^"]+"/, `"id": "${over.id}"`)
  if (over.created !== undefined) s = s.replace(/"created": \d+/, `"created": ${over.created}`)
  return s
}
const withStatus = (body: string, status: string) => body.replace('"status": "active"', `"status": "${status}"`)
const sign = (body: string, secret = process.env.STRIPE_WEBHOOK_SECRET!, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const post = (body: string, signature: string | null) => webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) } }))
const deliver = async (body: string) => { const r = await post(body, sign(body)); return { status: r.status, ...(await r.json()) as { result?: string } } }

async function scenario(engine: 'sqlite' | 'pg') {
  const db = await getDb()
  const id = () => randomBytes(4).toString('hex')
  const A = { TENANT: 'tenantA' + id(), CUSTOMER: 'cus_A' + id(), SUBSCRIPTION: 'sub_A' + id() }
  const B = { TENANT: 'tenantB' + id(), CUSTOMER: 'cus_B' + id(), SUBSCRIPTION: 'sub_B' + id() }
  const row = (t: { TENANT: string }) => db.get('SELECT * FROM tenant_plans WHERE tenant_id = ?', [t.TENANT])
  const view = async (t: { TENANT: string }) => {
    setUser({ id: t.TENANT, business_name: 'Co' } as never)
    const u = await (await usage.GET(new NextRequest('https://dazl.test/api/usage'))).json() as { plan: string; scan_limit: number | null; billing_status: string | null }
    return { plan: u.plan, scan_limit: u.scan_limit, billing_status: u.billing_status }
  }
  const PRO = (status: string) => ({ plan: 'pro', scan_limit: null, billing_status: status })
  const FREE = (status: string | null) => ({ plan: 'free', scan_limit: 50, billing_status: status })
  // Both tenants subscribe: checkout.session.completed, each for its own customer
  assert.deepEqual(await view(A), FREE(null))
  for (const [t, evt] of [[A, 'evt_co_A'], [B, 'evt_co_B']] as const) {
    const body = fixture('checkout.session.completed', t, { id: evt + id() })
    assert.equal((await post(body, null)).status, 400, 'unsigned: refused')
    assert.equal((await post(body, sign(body, 'whsec_wrong'))).status, 400, 'wrong secret: refused')
    assert.deepEqual(await deliver(body), { status: 200, result: 'applied' })
    assert.deepEqual(await deliver(body), { status: 200, result: 'duplicate' }, 'replay: a duplicate, applied once')
  }
  assert.deepEqual(await view(A), PRO('active'))
  // every step on A from here: B's stored row, byte for byte, and what B's usage shows, are unchanged
  const bRow = await row(B), bView = await view(B)
  assert.deepEqual(bView, PRO('active'))
  const bUntouched = async (step: string) => {
    assert.deepEqual(await row(B), bRow, `${step}: tenant B's plan row changed`)
    assert.deepEqual(await view(B), bView, `${step}: tenant B's plan as shown changed`)
  }

  // invoice.payment_failed: Stripe retries, so A stays Pro, but its billing status says past_due
  const failed = fixture('invoice.payment_failed', A, { id: 'evt_pf_' + id(), created: 1793000150 })
  assert.deepEqual(await deliver(failed), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A), PRO('past_due'))
  assert.deepEqual(await deliver(failed), { status: 200, result: 'duplicate' })
  await bUntouched('invoice.payment_failed')

  // The same event delivered five times at once: applied exactly once, the rest are duplicates
  const again = fixture('invoice.payment_failed', A, { id: 'evt_pf_burst_' + id(), created: 1793000160 })
  const burst = await Promise.all(Array.from({ length: 5 }, () => deliver(again)))
  assert.deepEqual(burst.map(r => r.result).sort(), ['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate'])
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events WHERE id LIKE ?', ['evt_pf_burst_%']))!.n), 1)
  await bUntouched('concurrent duplicate deliveries')

  // The retry succeeds: subscription.updated active (later) puts the status back
  const recovered = fixture('customer.subscription.updated.cancel_at_period_end', A, { id: 'evt_rec_' + id(), created: 1793000170 }).replace('"cancel_at_period_end": true', '"cancel_at_period_end": false')
  assert.deepEqual(await deliver(recovered), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A), PRO('active'))
  // ...and a payment failure created before the recovery, delivered after it, is stale
  const lateFail = fixture('invoice.payment_failed', A, { id: 'evt_pf_late_' + id(), created: 1793000165 })
  assert.deepEqual(await deliver(lateFail), { status: 200, result: 'stale' })
  assert.deepEqual(await view(A), PRO('active'))
  // an invoice naming B's subscription under A's customer is not A's current subscription: nothing changes
  const crossed = fixture('invoice.payment_failed', { ...A, SUBSCRIPTION: B.SUBSCRIPTION }, { id: 'evt_pf_cross_' + id(), created: 1793000175 })
  assert.deepEqual(await deliver(crossed), { status: 200, result: 'ignored' })
  assert.deepEqual(await view(A), PRO('active'))
  // the pre-2025 invoice shape (subscription at the top level) is read too
  const legacy = fixture('invoice.payment_failed', A, { id: 'evt_pf_legacy_' + id(), created: 1793000180 })
    .replace(/"parent": \{[^\n]*\},\n/, `"subscription": "${A.SUBSCRIPTION}",\n`)
  assert.ok(!legacy.includes('subscription_details'))
  assert.deepEqual(await deliver(legacy), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A), PRO('past_due'))
  await bUntouched('payment recovery, stale and crossed invoices')

  // Stripe gives up: subscription.updated unpaid drops A to Free (50 a month); a later payment failure never brings Pro back
  const unpaid = withStatus(fixture('customer.subscription.updated.cancel_at_period_end', A, { id: 'evt_unpaid_' + id(), created: 1793000190 }), 'unpaid')
  assert.deepEqual(await deliver(unpaid), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A), FREE('unpaid'))
  const afterUnpaid = fixture('invoice.payment_failed', A, { id: 'evt_pf_free_' + id(), created: 1793000195 })
  assert.deepEqual(await deliver(afterUnpaid), { status: 200, result: 'ignored' })
  assert.deepEqual(await view(A), FREE('unpaid'))
  await bUntouched('subscription.updated unpaid')

  // subscription.deleted: A is Free and canceled; an invoice of the ended subscription is stale
  const deleted = fixture('customer.subscription.deleted', A, { id: 'evt_del_' + id(), created: 1793000200 })
  assert.deepEqual(await deliver(deleted), { status: 200, result: 'applied' })
  assert.deepEqual(await deliver(deleted), { status: 200, result: 'duplicate' })
  assert.deepEqual(await view(A), FREE('canceled'))
  const endedFail = fixture('invoice.payment_failed', A, { id: 'evt_pf_ended_' + id(), created: 1793000210 })
  assert.deepEqual(await deliver(endedFail), { status: 200, result: 'stale' })
  assert.deepEqual(await view(A), FREE('canceled'))
  await bUntouched('subscription.deleted')

  // and the other way round: B's payment failure and cancellation never touch A
  const aRow = await row(A)
  for (const body of [
    fixture('invoice.payment_failed', B, { id: 'evt_pf_B_' + id(), created: 1793000150 }),
    fixture('customer.subscription.deleted', B, { id: 'evt_del_B_' + id(), created: 1793000200 }),
  ]) assert.deepEqual(await deliver(body), { status: 200, result: 'applied' })
  assert.deepEqual(await view(B), FREE('canceled'))
  assert.deepEqual(await row(A), aRow, "tenant B's events changed tenant A's row")
  console.log('STRIPE_EVENTS', engine)
}

test('Stripe webhook events on SQLite: plan, limits and billing status per event; once per event id; tenants isolated', async () => {
  await getDb()
  setScanDb(getAuthDb())
  await scenario('sqlite')
})

test('Stripe webhook events on Postgres: the same, with the SQLite handle trapped', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 5 })
  try {
    await runPgMigrations(pg.pool)
    setDb(pg)
    // Production on Postgres has no raw SQLite handle: trap it so a module still reaching for getScanDb fails here,
    // as it would in production. The previous empty-SQLite substitution also repointed getDb() off Postgres
    // (tenant-route-db.setScanDb calls setDb(sqliteDb(v))) - the leg printed a pg marker while running on SQLite.
    trapScanDb()
    assert.equal((await getDb()).kind, 'pg', 'engine canary: the route-facing store IS Postgres, not a fixture SQLite repointed by setScanDb')
    await scenario('pg')
  } finally { await pg.close(); await s.drop() }
})
