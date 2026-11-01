// Stripe in test mode, end to end, on SQLite and on Postgres (test/stripe-flow.test.ts), through the real routes:
//   checkout (POST /api/billing/checkout) -> Stripe's signed webhook (POST /api/stripe) -> the account's plan
//   (GET /api/usage) -> the plan's limit on the next scan (POST /api/scan) -> cancel at period end (still Pro) ->
//   subscription deleted -> Free, and the limit is back.
// Webhook bodies are Stripe-shaped test-mode events (test/fixtures/stripe, livemode false) signed the way Stripe signs
// them: Stripe-Signature t=<unix time>,v1=HMAC-SHA256(secret, "<t>.<raw body>"). api.stripe.com is a local stub that
// records the checkout request; every other outbound call fails the test. No real key, no charge, no scan runs (the
// runner is never started: after() is recorded, not run).
// On Postgres the plan, the Stripe events and the account read from Postgres; POST /api/scan still counts and queues
// scans on its own SQLite handle (it is listed in lib/db/pg-port-status.ts), as it does in a split deployment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture_pro', PUBLIC_BASE_URL: 'https://staging.dazl.test',
  STRIPE_WEBHOOK_SECRET: 'whsec_fixture' + randomBytes(8).toString('hex'), DAZL_MASTER_KEY: randomBytes(32).toString('base64') })

const { setDb, pgDb, getDb } = await import('../../lib/db/client.ts')
const { runPgMigrations } = await import('../../lib/db/migrate-pg.ts')
const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
const { saveKey } = await import('../../lib/llm/key-store.ts')
const { PLAN_LIMITS } = await import('../../lib/plans.ts')
const checkout = await import('../../app/api/billing/checkout/route.ts')
const stripe = await import('../../app/api/stripe/route.ts')
const usage = await import('../../app/api/usage/route.ts')
const scan = await import('../../app/api/scan/route.ts')

const checkoutCalls: URLSearchParams[] = []
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input))
  if (u.hostname !== 'api.stripe.com' || u.pathname !== '/v1/checkout/sessions') throw new Error(`Unexpected network call to ${u.href}`)
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk_test_fixture')
  checkoutCalls.push(new URLSearchParams(String(init?.body ?? '')))
  return new Response(JSON.stringify({ id: 'cs_test_fixture', url: 'https://checkout.stripe.test/c/pay/cs_test_fixture' }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

// a Stripe test-mode event, its ids filled in, signed as Stripe signs it
const event = (name: string, vars: Record<string, string>, id: string, created?: number) => {
  let s = Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
    .replace(/"id": "evt_[^"]+"/, `"id": "${id}"`)
  if (created) s = s.replace(/"created": \d+/, `"created": ${created}`)
  assert.equal(JSON.parse(s).livemode, false, 'test-mode events only')
  return s
}
const signature = (body: string, secret = process.env.STRIPE_WEBHOOK_SECRET!, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
const post = async (body: string, sig: string | null) => {
  const r = await stripe.POST(new NextRequest('https://staging.dazl.test/api/stripe', { method: 'POST', body, headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) } }))
  return { status: r.status, ...(await r.json()) as { result?: string } }
}
const deliver = (body: string) => post(body, signature(body))
const as = (id: string) => setUser({ id, business_name: 'Acme', email: `${id.slice(0, 6)}@example.test` } as never)
const account = async (id: string) => { as(id); const u = await (await usage.GET(new NextRequest('https://staging.dazl.test/api/usage'))).json() as { plan: string; scan_limit: number | null; billing_status: string | null }; return { plan: u.plan, scan_limit: u.scan_limit, billing_status: u.billing_status } }
const startScan = async (id: string) => { as(id); const r = await scan.POST(new NextRequest('https://staging.dazl.test/api/scan', { method: 'POST', body: JSON.stringify({ query: 'companies hiring sales reps in Toronto' }), headers: { 'content-type': 'application/json', host: 'staging.dazl.test', origin: 'https://staging.dazl.test' } })); return { status: r.status, ...(await r.json()) as { error?: string; job_id?: string } } }
const FREE = { plan: 'free', scan_limit: PLAN_LIMITS.free.scansPerMonth, billing_status: null as string | null }
const PRO = (s: string) => ({ plan: 'pro', scan_limit: null, billing_status: s })

async function scenario(engine: string, jobs: Database.Database) {
  const id = () => randomBytes(4).toString('hex')
  const calls0 = checkoutCalls.length
  const A = { TENANT: 'a'.repeat(28) + id(), CUSTOMER: 'cus_A' + id(), SUBSCRIPTION: 'sub_A' + id() }
  const B = 'b'.repeat(28) + id()
  // A has its own AI key (not a trial) and has used this month's Free allowance
  for (const t of [A.TENANT, B]) saveKey(jobs, t, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
  const limit = PLAN_LIMITS.free.scansPerMonth!
  const ins = jobs.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'Acme', 'software', 'Toronto')")
  for (let i = 0; i < limit; i++) ins.run(`${engine}${id()}${String(i).padStart(10, '0')}`, A.TENANT)
  const finishScans = () => { jobs.prepare("UPDATE scan_jobs SET status = 'running' WHERE user_id = ? AND status = 'pending'").run(A.TENANT); jobs.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ? AND status = 'running'").run(A.TENANT) }
  finishScans()

  // 1. Free at its limit: the next scan is refused, nothing queued
  assert.deepEqual(await account(A.TENANT), FREE)
  assert.deepEqual(await startScan(A.TENANT), { status: 402, error: 'quota_exceeded', plan: 'free', used: limit, limit })

  // 2. Checkout: a test-mode session for A's Pro price; the tenant rides in client_reference_id and the subscription
  //    metadata; returning from Stripe lands on the staging URL. Paying happens on Stripe: nothing changes yet.
  as(A.TENANT)
  const co = await checkout.POST(new NextRequest('https://staging.dazl.test/api/billing/checkout', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', host: 'staging.dazl.test', origin: 'https://staging.dazl.test' } }))
  assert.equal(co.status, 200)
  const form = checkoutCalls.at(-1)!
  assert.deepEqual([form.get('mode'), form.get('client_reference_id'), form.get('subscription_data[metadata][tenant_id]'), form.get('line_items[0][price]'), form.get('success_url')],
    ['subscription', A.TENANT, A.TENANT, 'price_fixture_pro', 'https://staging.dazl.test/app/settings?billing=success'])
  assert.deepEqual(await account(A.TENANT), FREE)

  // 3. Stripe's signed checkout.session.completed: A is Pro, its scan limit lifts, the next scan is queued
  const completed = event('checkout.session.completed', A, 'evt_co_' + id())
  // only Stripe's signature counts: none, another secret, a body changed after signing, or a stale timestamp -> 400
  const now = Math.floor(Date.now() / 1000)
  const refused: [string, string | null][] = [
    [completed, null],                                     // unsigned
    [completed, signature(completed, 'whsec_other')],      // signed with another secret
    [completed + ' ', signature(completed)],               // body changed after signing
    [completed, signature(completed, undefined, now - 3600)], // a replay outside Stripe's 5-minute tolerance
  ]
  for (const [body, sig] of refused) assert.equal((await post(body, sig)).status, 400)
  assert.deepEqual(await account(A.TENANT), FREE, 'a refused delivery changes nothing')
  assert.deepEqual(await deliver(completed), { status: 200, result: 'applied' })
  assert.deepEqual(await account(A.TENANT), PRO('active'))
  const s1 = await startScan(A.TENANT)
  assert.equal(s1.status, 202, JSON.stringify(s1))
  assert.deepEqual(await deliver(completed), { status: 200, result: 'duplicate' }, 'Stripe retries the same event: no-op')
  finishScans()

  // 4. Cancel at period end (customer.subscription.updated, cancel_at_period_end): still Pro until the period ends
  assert.deepEqual(await deliver(event('customer.subscription.updated.cancel_at_period_end', A, 'evt_upd_' + id())), { status: 200, result: 'applied' })
  assert.deepEqual(await account(A.TENANT), PRO('active'))
  assert.equal((await startScan(A.TENANT)).status, 202)
  finishScans()

  // 5. The subscription ends (customer.subscription.deleted): Free again, canceled, and the limit is back
  assert.deepEqual(await deliver(event('customer.subscription.deleted', A, 'evt_del_' + id())), { status: 200, result: 'applied' })
  assert.deepEqual(await account(A.TENANT), { ...FREE, billing_status: 'canceled' })
  const s3 = await startScan(A.TENANT)
  assert.deepEqual([s3.status, s3.error], [402, 'quota_exceeded'])

  // B, another tenant on the same store, was never touched by any of A's events
  assert.deepEqual(await account(B), FREE)
  assert.equal(checkoutCalls.length - calls0, 1, 'one checkout request to the Stripe stub, nothing else left the process')
  console.log('STRIPE_FLOW_OK', engine)
}

test('Stripe test mode end to end on SQLite', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  await scenario('sqlite', raw)
})

test('Stripe test mode end to end on Postgres', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw) // POST /api/scan's own handle
    setDb(pg)                                                                     // the plan, Stripe events and the account
    assert.equal((await getDb()).kind, 'pg', 'engine canary: the route-facing store IS Postgres, not a fixture SQLite repointed by setScanDb')
    await scenario('pg', raw)
    // the plan lives in Postgres, not in the SQLite handle
    assert.equal((raw.prepare('SELECT count(*) AS n FROM tenant_plans').get() as { n: number }).n, 0)
    assert.ok(Number((await pg.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events'))!.n) >= 3)
  } finally { await pg.close(); await s.drop() }
})
