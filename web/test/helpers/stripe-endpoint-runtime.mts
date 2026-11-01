// Stripe end to end in test mode through /api/stripe (test/stripe-endpoint.test.ts): checkout carries the tenant, the
// signed webhook moves that tenant's plan in the real store and nothing else, replays are no-ops, an unsigned or
// tampered delivery changes nothing, and an event for a tenant the store does not know answers 200, is logged, and
// changes no plan. Stripe is never reached: api.stripe.com is a stub that records the checkout call, and webhook bodies
// are Stripe-shaped fixtures signed with a test secret. SQLite, and Postgres (with DAZL_TEST_PG_URL) with the raw
// SQLite handle trapped (trapScanDb): on the Postgres leg getDb() IS the Postgres store, so section 7's conversion
// write and its injected failure exercise the same Db-over-Postgres boundary production runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { setScanDb, setUser, getScanDb, trapScanDb } from './tenant-route-db.ts'
import { migrateLifecycle } from '../../lib/outreach/lifecycle.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture_pro'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.PUBLIC_BASE_URL = 'https://dazl.test'

const { getDb, setDb, pgDb } = await import('../../lib/db/client.ts')
const { runPgMigrations } = await import('../../lib/db/migrate-pg.ts')
const { getAuthDb } = await import('../../lib/auth-db.ts')
const stripe = await import('../../app/api/stripe/route.ts')
const checkout = await import('../../app/api/billing/checkout/route.ts')
const usage = await import('../../app/api/usage/route.ts')

const checkoutCalls: URLSearchParams[] = []
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input))
  if (u.hostname !== 'api.stripe.com' || u.pathname !== '/v1/checkout/sessions') throw new Error(`Unexpected network call to ${u.href}`)
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk_test_fixture')
  checkoutCalls.push(new URLSearchParams(String(init?.body ?? '')))
  return new Response(JSON.stringify({ id: 'cs_test_fixture', url: 'https://checkout.stripe.test/c/pay/cs_test_fixture' }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const fixture = (name: string, vars: Record<string, string>, id: string) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
    .replace(/"id": "evt_[^"]+"/, `"id": "${id}"`)
const sign = (body: string, secret = process.env.STRIPE_WEBHOOK_SECRET!) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` }
const post = (body: string, signature: string | null) => stripe.POST(new NextRequest('https://dazl.test/api/stripe', {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) } }))
const deliver = async (body: string) => { const r = await post(body, sign(body)); return { status: r.status, ...(await r.json()) as { result?: string } } }
const view = async (tenant: string) => {
  setUser({ id: tenant, business_name: 'Co', email: `${tenant.slice(0, 6)}@example.test` } as never)
  const u = await (await usage.GET(new NextRequest('https://dazl.test/api/usage'))).json() as { plan: string; scan_limit: number | null; billing_status: string | null }
  return { plan: u.plan, scan_limit: u.scan_limit, billing_status: u.billing_status }
}
const PRO = (s: string) => ({ plan: 'pro', scan_limit: null, billing_status: s })
const FREE = (s: string | null) => ({ plan: 'free', scan_limit: 50, billing_status: s })

async function scenario(engine: string) {
  const db = await getDb()
  const id = () => randomBytes(4).toString('hex')
  const A = { TENANT: 'a'.repeat(28) + id(), CUSTOMER: 'cus_A' + id(), SUBSCRIPTION: 'sub_A' + id() }
  const B = { TENANT: 'b'.repeat(28) + id(), CUSTOMER: 'cus_B' + id(), SUBSCRIPTION: 'sub_B' + id() }
  const plans = () => db.all('SELECT * FROM tenant_plans ORDER BY tenant_id')

  // 1. Checkout: tenant A starts a session; the tenant goes in client_reference_id and the subscription metadata
  setUser({ id: A.TENANT, business_name: 'Co', email: 'a@example.test' } as never)
  const co = await checkout.POST(new NextRequest('https://dazl.test/api/billing/checkout', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } }))
  assert.equal(co.status, 200)
  assert.equal((await co.json()).url, 'https://checkout.stripe.test/c/pay/cs_test_fixture')
  const form = checkoutCalls.at(-1)!
  assert.deepEqual([form.get('mode'), form.get('client_reference_id'), form.get('subscription_data[metadata][tenant_id]'), form.get('line_items[0][price]')], ['subscription', A.TENANT, A.TENANT, 'price_fixture_pro'])
  assert.deepEqual(await view(A.TENANT), FREE(null), 'paying happens on Stripe; only the webhook upgrades')

  // B subscribes too, so every later step can show B's row is never touched
  assert.deepEqual(await deliver(fixture('checkout.session.completed', B, 'evt_b_' + id())), { status: 200, result: 'applied' })
  const bRow = await db.get('SELECT * FROM tenant_plans WHERE tenant_id = ?', [B.TENANT])
  const bUntouched = async (step: string) => assert.deepEqual(await db.get('SELECT * FROM tenant_plans WHERE tenant_id = ?', [B.TENANT]), bRow, `${step}: tenant B changed`)

  // 2. Bad signatures: unsigned, wrong secret, body changed after signing -> 400, nothing changes
  const completed = fixture('checkout.session.completed', A, 'evt_a_co_' + id())
  const before = JSON.stringify(await plans())
  assert.equal((await post(completed, null)).status, 400)
  assert.equal((await post(completed, sign(completed, 'whsec_wrong'))).status, 400)
  assert.equal((await post(completed + ' ', sign(completed))).status, 400)
  assert.equal(JSON.stringify(await plans()), before, 'a refused delivery changes nothing')

  // 3. Happy path: checkout.session.completed -> Pro; a replay of the same event id is a no-op
  assert.deepEqual(await deliver(completed), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A.TENANT), PRO('active'))
  const afterApply = JSON.stringify(await plans())
  assert.deepEqual(await deliver(completed), { status: 200, result: 'duplicate' })
  assert.equal(JSON.stringify(await plans()), afterApply, 'replay changes nothing')
  await bUntouched('checkout')

  // 4. invoice.payment_failed: Stripe retries, still Pro, billing status past_due
  assert.deepEqual(await deliver(fixture('invoice.payment_failed', A, 'evt_a_pf_' + id())), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A.TENANT), PRO('past_due'))
  await bUntouched('payment failed')

  // 5. Downgrade: subscription.updated unpaid -> Free (50 a month); then cancel: subscription.deleted -> Free, canceled
  const unpaid = fixture('customer.subscription.updated.cancel_at_period_end', A, 'evt_a_unpaid_' + id()).replace('"status": "active"', '"status": "unpaid"').replace(/"created": \d+/, '"created": 1793000180')
  assert.deepEqual(await deliver(unpaid), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A.TENANT), FREE('unpaid'))
  assert.deepEqual(await deliver(fixture('customer.subscription.deleted', A, 'evt_a_del_' + id())), { status: 200, result: 'applied' })
  assert.deepEqual(await view(A.TENANT), FREE('canceled'))
  await bUntouched('downgrade and cancel')

  // 6. Unknown tenant: a signed event naming no tenant and a customer no tenant has -> 200, logged, no plan changes
  const stranger = fixture('checkout.session.completed', { TENANT: '', CUSTOMER: 'cus_nobody' + id(), SUBSCRIPTION: 'sub_nobody' + id() }, 'evt_unknown' + id())
    .replace('"client_reference_id": "",', '"client_reference_id": null,')
  const plansBefore = JSON.stringify(await plans())
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { if (String(chunk).includes('"type":"stripe_event"')) { lines.push(String(chunk)); return true } return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest) }) as typeof process.stdout.write
  let res
  try { res = await deliver(stranger) } finally { process.stdout.write = write }
  assert.deepEqual(res, { status: 200, result: 'ignored' })
  assert.equal(JSON.stringify(await plans()), plansBefore, 'no tenant\'s plan changed')
  assert.equal(lines.length, 1)
  const line = JSON.parse(lines[0])
  assert.deepEqual({ ...line, ts: 0 }, { level: 'warn', type: 'stripe_event', ts: 0, event_id: JSON.parse(stranger).id, event_type: 'checkout.session.completed', result: 'ignored', reason: 'unknown_tenant' })
  assert.ok(!lines[0].includes('cus_nobody'), 'no customer id in the log')
  assert.deepEqual(await deliver(stranger), { status: 200, result: 'duplicate' }, 'its replay is a no-op too')
  await bUntouched('unknown tenant')
  assert.deepEqual(await view(B.TENANT), PRO('active'))

  // 7. #417 conversion on payment: the identity is the ACCOUNT bound to the checkout (client_reference_id),
  // never the buyer-typed Stripe email. A verified account email cancels its queued acquisition work now; an
  // unverified one queues a durable pending conversion; a store failure answers 503 and the Stripe replay
  // (a 'duplicate' that still reaches the conversion block) completes it. Everything in this section goes through
  // the Db layer, so on the Postgres leg the conversion write, the failure injection and every assertion hit the
  // Postgres store itself - the same boundary production runs (app/api/billing/webhook/route.ts -> getDb()).
  const C = { TENANT: 'c'.repeat(28) + id(), CUSTOMER: 'cus_C' + id(), SUBSCRIPTION: 'sub_C' + id() }
  await db.run("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES (?, 'c-owner@example.test', 'x', 'y', 100)", [C.TENANT])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('mc1', ?, 'lc1', 'c-owner@example.test', 'hi', 'bodybodybodybodybodybody', 'draft', 'warmup_manual', 1800000100)", [C.TENANT])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('mc2', ?, 'lc2', 'bystander@example.test', 'hi', 'bodybodybodybodybodybody', 'draft', 'warmup_manual', 1800000100)", [C.TENANT])
  const cEvent = fixture('checkout.session.completed', C, 'evt_c_co_' + id())
    .replace('"customer":', '"customer_details": { "email": "bystander@example.test" }, "customer":') // buyer-typed email names a bystander
  assert.deepEqual(await deliver(cEvent), { status: 200, result: 'applied' })
  assert.equal((await db.get<{ status: string }>("SELECT status FROM outreach_messages WHERE id = 'mc1'"))!.status, 'skipped', 'verified paying account: its queued work stops')
  assert.equal((await db.get<{ error: string }>("SELECT status, error FROM outreach_messages WHERE id = 'mc1'"))!.error, 'converted_payment')
  assert.equal((await db.get<{ status: string }>("SELECT status FROM outreach_messages WHERE id = 'mc2'"))!.status, 'draft', 'the buyer-typed Stripe email is never used: the bystander keeps their queued work')
  assert.equal(await db.get("SELECT 1 AS x FROM lifecycle_events WHERE kind = 'payment' AND email = 'c-owner@example.test' AND activated_at IS NOT NULL") !== undefined, true)

  // Unverified account email: nothing cancels; a durable pending conversion waits for verification.
  const D = { TENANT: 'd'.repeat(28) + id(), CUSTOMER: 'cus_D' + id(), SUBSCRIPTION: 'sub_D' + id() }
  await db.run("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES (?, 'd-owner@example.test', 'x', 'y', NULL)", [D.TENANT])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('md1', ?, 'ld1', 'd-owner@example.test', 'hi', 'bodybodybodybodybodybody', 'draft', 'warmup_manual', 1800000100)", [D.TENANT])
  assert.deepEqual(await deliver(fixture('checkout.session.completed', D, 'evt_d_co_' + id())), { status: 200, result: 'applied' })
  assert.equal((await db.get<{ status: string }>("SELECT status FROM outreach_messages WHERE id = 'md1'"))!.status, 'draft', 'unverified account: nothing canceled')
  assert.equal(await db.get("SELECT 1 AS x FROM lifecycle_events WHERE kind = 'payment' AND email = 'd-owner@example.test' AND activated_at IS NULL") !== undefined, true, 'a durable pending conversion waits for verification')

  // Store failure on the conversion write, injected on the store the route actually writes (lifecycle_events on
  // THIS engine): 503 (Stripe will retry), the plan change already applied; the replay arrives as 'duplicate',
  // still reaches the conversion block, and completes it exactly once.
  const injectLifecycleFailure = async () => {
    if (db.kind === 'pg') {
      await db.run("CREATE OR REPLACE FUNCTION fail_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected store failure'; END $f$")
      await db.run('CREATE TRIGGER fail_lifecycle BEFORE INSERT ON lifecycle_events FOR EACH ROW EXECUTE FUNCTION fail_lifecycle()')
    } else {
      getScanDb().exec("CREATE TRIGGER fail_lifecycle BEFORE INSERT ON lifecycle_events BEGIN SELECT RAISE(ABORT, 'injected store failure'); END")
    }
  }
  const clearLifecycleFailure = async () => {
    if (db.kind === 'pg') {
      await db.run('DROP TRIGGER fail_lifecycle ON lifecycle_events')
      await db.run('DROP FUNCTION fail_lifecycle()')
    } else {
      getScanDb().exec('DROP TRIGGER fail_lifecycle')
      migrateLifecycle(getScanDb())
    }
  }
  const E = { TENANT: 'e'.repeat(28) + id(), CUSTOMER: 'cus_E' + id(), SUBSCRIPTION: 'sub_E' + id() }
  await db.run("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES (?, 'e-owner@example.test', 'x', 'y', 100)", [E.TENANT])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('me1', ?, 'le1', 'e-owner@example.test', 'hi', 'bodybodybodybodybodybody', 'draft', 'warmup_manual', 1800000100)", [E.TENANT])
  await injectLifecycleFailure()
  const eEvent = fixture('checkout.session.completed', E, 'evt_e_co_' + id())
  const failed = await deliver(eEvent)
  assert.equal(failed.status, 503, 'conversion store failure answers 503 so Stripe retries')
  assert.equal((await db.get<{ status: string }>("SELECT status FROM outreach_messages WHERE id = 'me1'"))!.status, 'draft', 'no half-applied conversion')
  await clearLifecycleFailure()
  assert.deepEqual(await deliver(eEvent), { status: 200, result: 'duplicate' }, 'the replayed event reaches the conversion block again')
  assert.equal((await db.get<{ status: string }>("SELECT status FROM outreach_messages WHERE id = 'me1'"))!.status, 'skipped', 'the recovered conversion cancels the queued work')
  assert.deepEqual(await deliver(eEvent), { status: 200, result: 'duplicate' }, 'further replays stay no-ops')

  console.log('STRIPE_ENDPOINT', engine)
}

test('Stripe through /api/stripe on SQLite', async () => {
  await getDb()
  setScanDb(getAuthDb())
  await scenario('sqlite')
})

test('Stripe through /api/stripe on Postgres, the SQLite handle trapped', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    setDb(pg)
    // Production on Postgres has no raw SQLite handle: trap it so any module still reaching for getScanDb fails
    // here instead of silently reading a fixture store (previously this leg handed the route an empty SQLite store,
    // which also repointed getDb() off Postgres - the leg proved nothing about Postgres).
    trapScanDb()
    assert.equal((await getDb()).kind, 'pg', 'engine canary: the route-facing store IS Postgres, not a fixture SQLite repointed by setScanDb')
    await scenario('pg')
  } finally { await pg.close(); await s.drop() }
})
