// #417 missed-hook recovery, through the real Stripe webhook route and the scheduler's catch-up, on SQLite and (with
// DAZL_TEST_PG_URL) a fresh Postgres schema with the SQLite handle trapped (test/lifecycle-recovery.test.ts).
// Scenario: dazl's acquisition workspace emailed a prospect; the prospect signed up and their plan shows an active
// subscription, but neither the sign-up hook nor any payment webhook reached the lifecycle record. The catch-up records
// an unverified sign-up and a checkout without payment (never "paid": a plan status is not money taken), stops the
// approved email and the sequence, and stays that way on the next tick. Only a later webhook showing money taken makes it
// "paid"; a trial checkout does not; a redelivered event is recorded once. Synthetic rows and Stripe-shaped bodies signed
// with a test secret; no call leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { setScanDb } from './tenant-route-db.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture_pro'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.PUBLIC_BASE_URL = 'https://dazl.test'
process.env.DAZL_ACQUISITION_TENANTS = 'acq'

const { getDb, setDb, pgDb } = await import('../../lib/db/client.ts')
const { runPgMigrations } = await import('../../lib/db/migrate-pg.ts')
const { getAuthDb } = await import('../../lib/auth-db.ts')
const webhook = await import('../../app/api/billing/webhook/route.ts')
const { reconcileLifecycle } = await import('../../lib/outreach/lifecycle.ts')

globalThis.fetch = (async (input: unknown) => { throw new Error(`Unexpected network call: ${String(input)}`) }) as typeof fetch

const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}`
const deliver = async (event: object) => {
  const body = JSON.stringify(event)
  const r = await webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) } }))
  return { status: r.status, ...(await r.json()) as { result?: string } }
}

async function scenario(engine: 'sqlite' | 'pg') {
  const db = await getDb()
  const id = () => randomBytes(12).toString('hex')
  const P = 'p' + id().slice(0, 10), CUS = 'cus_' + id().slice(0, 10), NOW = 1_800_000_000
  for (const [u, email] of [['acq', 'growth@dazl.example'], [P, 'owner@prospect.example']]) await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y') ON CONFLICT (id) DO NOTHING", [u, email])
  // dazl's acquisition outreach to the prospect: an approved first email and an active sequence
  const job = id(), lead = id(), mid = id(), seq = id()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'acq', 'dazl', 'x', 'y', 'running', ?)", [job, NOW])
  await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES (?, ?, 'Prospect Co', 'hiring', 'https://p.example/jobs')", [lead, job])
  await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ?", [job])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, approved_hash) VALUES (?, 'acq', ?, 'owner@prospect.example', 'Hi', 'A synthetic first email body.', 'approved', 'h')", [mid, lead])
  await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, 'acq', ?, ?, 'owner@prospect.example', 'active')", [seq, lead, mid])
  // The prospect's plan shows an active subscription, but no lifecycle hook ran and no checkout/invoice webhook arrived.
  await db.run("INSERT INTO tenant_plans (tenant_id, plan, subscription_status, stripe_customer_id) VALUES (?, 'pro', 'active', ?)", [P, CUS])
  const state = async () => ({
    hold: (await db.get<{ status: string }>("SELECT status FROM acquisition_holds WHERE tenant_id = 'acq'"))?.status ?? null,
    message: (await db.get<{ status: string }>('SELECT status FROM outreach_messages WHERE id = ?', [mid]))!.status,
    sequence: await db.get<{ status: string; stop_reason: string | null }>('SELECT status, stop_reason FROM sequences WHERE id = ?', [seq]),
    events: (await db.all<{ kind: string }>('SELECT kind FROM acquisition_lifecycle_events WHERE user_id = ? ORDER BY kind', [P])).map(r => r.kind),
  })
  assert.deepEqual((await state()).hold, null, 'before the catch-up: nothing recorded')

  // 1. The scheduler's catch-up: an unverified sign-up and a checkout without payment; never "paid".
  const r1 = await reconcileLifecycle(db, process.env, NOW + 60)
  assert.ok(r1.recorded >= 2, JSON.stringify(r1))
  assert.deepEqual(await state(), { hold: 'checkout_unpaid', message: 'draft', sequence: { status: 'stopped', stop_reason: 'checkout_unpaid' }, events: ['checkout_unpaid', 'signup_unverified'] })
  // 2. The next tick changes nothing: a plan status never becomes payment.
  await reconcileLifecycle(db, process.env, NOW + 120)
  assert.deepEqual((await state()).hold, 'checkout_unpaid')
  // 3. A trial checkout arriving late (no payment required): still not paid.
  const trial = { id: 'evt_' + id(), object: 'event', created: NOW + 200, type: 'checkout.session.completed', data: { object: { id: 'cs_' + id(), object: 'checkout.session', mode: 'subscription', payment_status: 'no_payment_required', amount_total: 0, client_reference_id: P, customer: CUS, subscription: 'sub_' + id(), metadata: {} } } }
  assert.equal((await deliver(trial)).status, 200)
  assert.deepEqual((await state()).hold, 'checkout_unpaid')
  // 4. Money taken (a paid invoice above zero): now paid; the same event redelivered is recorded once.
  const paid = { id: 'evt_' + id(), object: 'event', created: NOW + 300, type: 'invoice.paid', data: { object: { id: 'in_' + id(), object: 'invoice', customer: CUS, paid: true, amount_paid: 4900 } } }
  assert.equal((await deliver(paid)).status, 200)
  assert.equal((await deliver(paid)).status, 200)
  const s4 = await state()
  assert.deepEqual([s4.hold, s4.sequence!.stop_reason], ['paid', 'converted_paid'])
  assert.equal((await db.get<{ n: number }>("SELECT count(*) AS n FROM acquisition_lifecycle_events WHERE event_key = ?", ['stripe:' + paid.id]))!.n, 1)
  console.log('LIFECYCLE_RECOVERY', engine)
}

test('#417 missed hooks on SQLite: the catch-up records the right state, never payment without money taken', async () => {
  await getDb()
  setScanDb(getAuthDb())
  await scenario('sqlite')
})

test('#417 missed hooks on Postgres: the same, with the SQLite handle trapped', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 5 })
  try {
    await runPgMigrations(pg.pool)
    setScanDb(null as unknown as Database.Database)
    setDb(pg)
    await scenario('pg')
  } finally { await pg.close(); await s.drop() }
})
