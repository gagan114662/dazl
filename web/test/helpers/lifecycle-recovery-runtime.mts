// #417 missed-hook recovery, through the real Stripe webhook route and the scheduler's catch-up, on SQLite and (with
// DAZL_TEST_PG_URL) a fresh Postgres schema with the SQLite handle trapped (test/lifecycle-recovery.test.ts).
// Scenario: dazl's acquisition workspace emailed a prospect; the prospect signed up and their plan shows an active
// subscription, but neither the sign-up hook nor any payment webhook reached the lifecycle record. The catch-up records
// an unverified sign-up and a checkout without payment (never "paid": a plan status is not money taken), stops the
// approved email and the sequence, and stays that way on the next tick. Only a later webhook showing money taken makes it
// "paid"; a trial checkout does not; a payment whose lifecycle write failed (500) is recorded on Stripe's redelivery,
// exactly once. A Google verification whose apply step was missed is recovered as verified, from the evidence the sign-in
// recorded in its own transaction, including on the late-identity path. Synthetic rows and Stripe-shaped bodies signed
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
const { resolveUser } = await import('../../lib/auth-google.ts')

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
  // 4. Money taken (a paid invoice above zero), but the lifecycle write fails after the Stripe event committed: the webhook
  //    answers 500, so Stripe redelivers. The redelivery (a duplicate for billing) records it: paid, exactly once.
  const paid = { id: 'evt_' + id(), object: 'event', created: NOW + 300, type: 'invoice.paid', data: { object: { id: 'in_' + id(), object: 'invoice', customer: CUS, paid: true, amount_paid: 4900 } } }
  await db.run('ALTER TABLE acquisition_lifecycle_events RENAME TO acquisition_lifecycle_events_down')
  const failed = await deliver(paid)
  await db.run('ALTER TABLE acquisition_lifecycle_events_down RENAME TO acquisition_lifecycle_events')
  assert.equal(failed.status, 500, 'the lifecycle write failed: Stripe is asked to deliver again')
  assert.ok(await db.get('SELECT 1 AS x FROM stripe_events WHERE id = ?', [paid.id]), 'the billing side of the event committed')
  assert.equal((await state()).hold, 'checkout_unpaid', 'not paid until the payment is recorded')
  const again = await deliver(paid)
  assert.deepEqual(again, { status: 200, result: 'duplicate' })
  assert.equal((await deliver(paid)).status, 200)
  const s4 = await state()
  assert.deepEqual([s4.hold, s4.sequence!.stop_reason], ['paid', 'converted_paid'])
  assert.equal((await db.get<{ n: number }>("SELECT count(*) AS n FROM acquisition_lifecycle_events WHERE event_key = ?", ['stripe:' + paid.id]))!.n, 1, 'recorded once')

  // 5. Google verification whose apply step never ran (the callback's write after the sign-in failed): the evidence was
  //    recorded in the sign-in's own transaction, so the catch-up applies it as a verified sign-up, not merely a hold.
  const G = 'g.owner@prospect2.example', lead2 = id(), mid2 = id(), seq2 = id()
  const job2 = id()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'acq', 'dazl', 'x', 'y', 'running', ?)", [job2, NOW])
  await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES (?, ?, 'Prospect Two', 'hiring', 'https://p2.example/jobs')", [lead2, job2])
  await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ?", [job2])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, approved_hash) VALUES (?, 'acq', ?, ?, 'Hi', 'A synthetic first email body.', 'approved', 'h')", [mid2, lead2, G])
  await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, 'acq', ?, ?, ?, 'active')", [seq2, lead2, mid2, G])
  const r = await resolveUser(db, { sub: 'google-sub-' + id(), email: G, name: 'Synthetic Owner' })
  assert.ok('user_id' in r && r.created)
  assert.deepEqual((await db.all<{ kind: string }>('SELECT kind FROM acquisition_lifecycle_events WHERE user_id = ? ORDER BY kind', [(r as { user_id: string }).user_id])).map(x => x.kind), ['signup_unverified', 'signup_verified'], 'recorded with the sign-in')
  await reconcileLifecycle(db, process.env, NOW + 400)
  const held2 = await db.get<{ status: string }>("SELECT h.status FROM acquisition_holds h JOIN acquisition_lifecycle_events e ON e.email_hash = h.email_hash WHERE h.tenant_id = 'acq' AND e.user_id = ? LIMIT 1", [(r as { user_id: string }).user_id])
  assert.equal(held2?.status, 'signed_up', 'recovered as verified, not only as an unverified hold')
  assert.deepEqual(await db.get('SELECT status, stop_reason FROM sequences WHERE id = ?', [seq2]), { status: 'stopped', stop_reason: 'converted_signup' })
  // 6. The "late identity" path: another sign-in for the same Google identity committed between this callback's two
  //    identity reads (deterministic ordering: the first read is shown nothing, as on Postgres before that commit is
  //    visible). This callback still records its own verification proof, for the address Google verified to it.
  const L = 'late.owner@prospect3.example', LSUB = 'google-sub-' + id()
  const first = await resolveUser(db, { sub: LSUB, email: L, name: 'Synthetic Late' })
  assert.ok('user_id' in first && first.created)
  const uid = (first as { user_id: string }).user_id
  await db.run("DELETE FROM acquisition_lifecycle_events WHERE user_id = ? AND kind = 'signup_verified'", [uid]) // the concurrent sign-in's own record is not this callback's proof
  const late = Object.create(db) as typeof db
  late.tx = (body => db.tx(function* (t) {
    let hidden = false
    const g = body(t)
    let step = g.next()
    while (!step.done) {
      const op = step.value as { op: string; sql: string }
      if (!hidden && op.op === 'get' && /FROM oauth_identities/.test(op.sql)) { hidden = true; step = g.next(undefined); continue }
      step = g.next(yield op as never)
    }
    return step.value
  })) as typeof db.tx
  const r6 = await resolveUser(late, { sub: LSUB, email: L, name: 'Synthetic Late' })
  assert.deepEqual(r6, { user_id: uid, created: false }, 'the late path: the existing account, signed in')
  assert.deepEqual((await db.all<{ kind: string }>("SELECT kind FROM acquisition_lifecycle_events WHERE user_id = ? AND kind = 'signup_verified'", [uid])).map(x => x.kind), ['signup_verified'], 'its own verification proof was recorded')
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
