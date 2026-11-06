// #417 transition through the real routes (tenant-route-loader.mjs): a conversion stops the converted address's
// queued acquisition work in every seller tenant and, in the same transaction, moves it onto the seller's OWN
// onboarding path - only where that seller holds an explicit opted-in policy. A seller without one gets the stop
// and nothing else. Two entry points: the scheduler tick (a verified conversion whose boundary drain was lost) and
// the signed Stripe webhook (a paid checkout, SQLite and, with DAZL_TEST_PG_URL, Postgres). Synthetic data only:
// Gmail is the staging stub, Stripe is never called (fetch throws), nothing is sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { setScanDb, setUser, trapScanDb } from './tenant-route-db.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.PUBLIC_BASE_URL = 'https://dazl.test'
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const { getDb, setDb, pgDb } = await import('../../lib/db/client.ts')
const { runPgMigrations } = await import('../../lib/db/migrate-pg.ts')
const { getAuthDb } = await import('../../lib/db/sqlite-store.ts')
const { ONBOARDING_POLICY_VERSION, onboardingSendAllowed } = await import('../../lib/outreach/onboarding-policy.ts')
const { POST: tick } = await import('../../app/api/internal/tick/route.ts')
const { GET: sequencesGet } = await import('../../app/api/outreach/sequences/route.ts')
const webhook = await import('../../app/api/billing/webhook/route.ts')

type Store = Awaited<ReturnType<typeof getDb>>
const BODY = 'bodybodybodybodybodybody'
const now = () => Math.floor(Date.now() / 1000)

// Seeds on the Db layer so the same rows exist on either engine.
async function seller(db: Store, tenant: string, optedIn: boolean) {
  await db.run("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)", [tenant, `${tenant}@seller.test`, `${tenant} Co`])
  if (optedIn) await db.run('INSERT INTO onboarding_policies (tenant_id, policy_version, opted_in_by, opted_in_at, withdrawn_at) VALUES (?, ?, ?, ?, NULL)', [tenant, ONBOARDING_POLICY_VERSION, tenant, now()])
}
// A sent first touch + its active cold sequence (step 2 not due yet) and a scheduler-held first touch on another lead.
async function acquisition(db: Store, tenant: string, email: string, tag: string) {
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 'hi', ?, 'sent', ?, ?)", [`m-${tag}`, tenant, `l-${tag}`, email, BODY, now(), now()])
  await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, ?, ?, ?, ?, 'active')", [`sq-${tag}`, tenant, `l-${tag}`, `m-${tag}`, email])
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES (?, ?, ?, ?, 'hi', ?, 'draft', 'warmup_manual', ?)", [`h-${tag}`, tenant, `lh-${tag}`, email, BODY, now() + 3600])
  // Experiment attribution snapshot of the sent touch: must survive the stop.
  await db.run('INSERT INTO outreach_signal_context (message_id, tenant_id, lead_id, scan_job_id, signal, captured_at) VALUES (?, ?, ?, ?, ?, ?)', [`m-${tag}`, tenant, `l-${tag}`, `j-${tag}`, 'Hiring', now()])
}
const seq = async (db: Store, id: string) => db.get<{ status: string; stop_reason: string | null }>('SELECT status, stop_reason FROM sequences WHERE id = ?', [id])
const msg = async (db: Store, id: string) => db.get<{ status: string; error: string | null }>('SELECT status, error FROM outreach_messages WHERE id = ?', [id])
const enrollments = async (db: Store, email: string) => db.all<{ tenant_id: string; source: string }>('SELECT tenant_id, source FROM onboarding_enrollments WHERE email = ? ORDER BY tenant_id', [email])
const enrolledAudit = async (db: Store, tenant: string) => db.all<{ detail: string | null }>("SELECT detail FROM onboarding_audit WHERE tenant_id = ? AND action = 'enrolled'", [tenant])
const count = async (db: Store, sql: string, p: unknown[] = []) => Number((await db.get<{ n: number | string }>(sql, p as never))!.n)

// SQLite store at the throwaway DB_PATH; routes on the raw handle read the same store.
let sqliteReady = false
async function sqliteStore() { const db = await getDb(); if (!sqliteReady) { setScanDb(getAuthDb()); sqliteReady = true } return db }

test('tick: a verified conversion whose drain was lost stops the cold sequences and transitions only the opted-in seller', async () => {
  const db = await sqliteStore()
  const S1 = 'seller-opted-' + randomBytes(3).toString('hex'), S2 = 'seller-cold-' + randomBytes(3).toString('hex')
  await seller(db, S1, true); await seller(db, S2, false)
  const email = 'buyer@prospect.test'
  await acquisition(db, S1, email, 't1'); await acquisition(db, S2, email, 't2')
  // Same company, different person: unrelated, must stay untouched.
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m-same', ?, 'l-same', 'colleague@prospect.test', 'hi', ?, 'sent', ?, ?)", [S1, BODY, now(), now()])
  await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('sq-same', ?, 'l-same', 'm-same', 'colleague@prospect.test', 'active')", [S1])
  // The buyer's account is verified, but the verification boundary's activation write was lost: still pending.
  await db.run("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES ('U-buyer', ?, 'x', 'y', ?)", [email, now()])
  await db.run("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES (?, 'signup', ?, 'U-buyer', ?, NULL)", [`signup|${email}`, email, now()])

  const call = () => tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))
  const r = await call()
  assert.equal(r.status, 200)
  assert.deepEqual(await seq(db, 'sq-t1'), { status: 'stopped', stop_reason: 'policy_stop' })
  assert.deepEqual(await seq(db, 'sq-t2'), { status: 'stopped', stop_reason: 'policy_stop' })
  assert.deepEqual(await msg(db, 'h-t1'), { status: 'skipped', error: 'policy_stop' })
  assert.deepEqual(await msg(db, 'h-t2'), { status: 'skipped', error: 'policy_stop' })
  assert.equal((await count(db, "SELECT COUNT(*) AS n FROM sequence_steps WHERE sequence_id IN ('sq-t1','sq-t2') AND status = 'sent'")), 0, 'no sales step went out')
  // The transition: the opted-in seller only.
  assert.deepEqual(await enrollments(db, email), [{ tenant_id: S1, source: 'conversion:signup' }])
  assert.deepEqual(await enrolledAudit(db, S1), [{ detail: 'conversion:signup' }], 'content-free consent evidence')
  assert.deepEqual(await enrolledAudit(db, S2), [], 'no policy, no onboarding')
  assert.equal(onboardingSendAllowed(getAuthDb(), S1, email), true)
  assert.equal(onboardingSendAllowed(getAuthDb(), S2, email), false)
  // Unrelated same-company address: untouched, not enrolled.
  assert.deepEqual(await seq(db, 'sq-same'), { status: 'active', stop_reason: null })
  assert.deepEqual(await enrollments(db, 'colleague@prospect.test'), [])
  // Attribution preserved; no suppression written (transactional mail unaffected).
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM outreach_signal_context WHERE message_id IN ('m-t1','m-t2')"), 2)
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM suppressions WHERE lower(email) = ?', [email]), 0)
  // The terminal conversion reason is what the seller's sequences view shows.
  setUser({ id: S1, business_name: 'S1 Co' })
  const view = await (await sequencesGet(new NextRequest('http://localhost/api/outreach/sequences'))).json() as { sequences: { id: string; status: string; stop_reason: string | null }[] }
  assert.deepEqual(view.sequences.filter(s => s.id === 'sq-t1').map(s => [s.status, s.stop_reason]), [['stopped', 'policy_stop']])

  // A second tick (retry/restart) resurrects nothing and enrolls nothing twice.
  assert.equal((await call()).status, 200)
  assert.equal((await seq(db, 'sq-t1'))!.status, 'stopped')
  assert.equal((await enrollments(db, email)).length, 1)
  assert.equal((await enrolledAudit(db, S1)).length, 1)
  console.log('TRANSITION_TICK ok')
})

const fixture = (vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), readFileSync(new URL('../fixtures/stripe/checkout.session.completed.json', import.meta.url), 'utf8'))
const sign = (body: string, t = now()) => `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}`
const deliver = (body: string) => webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) } }))

async function webhookScenario(engine: 'sqlite' | 'pg') {
  const db = await getDb()
  const tag = randomBytes(3).toString('hex')
  const S1 = `seller-opted-${tag}`, S2 = `seller-cold-${tag}`, S3 = `seller-withdrawn-${tag}`
  await seller(db, S1, true); await seller(db, S2, false); await seller(db, S3, true)
  await db.run('UPDATE onboarding_policies SET withdrawn_at = ? WHERE tenant_id = ?', [now(), S3]) // withdrawn: no consent any more
  const P = `payer-${tag}`, email = `payer-${tag}@buyer.test`
  await db.run("INSERT INTO users (id, email, password_hash, salt, business_name, email_verified_at) VALUES (?, ?, 'x', 'y', 'Buyer Co', ?)", [P, email, now()])
  await acquisition(db, S1, email, `${tag}a`); await acquisition(db, S2, email, `${tag}b`); await acquisition(db, S3, email, `${tag}c`)

  const body = fixture({ TENANT: P, CUSTOMER: `cus_${tag}`, SUBSCRIPTION: `sub_${tag}` }).replace(/"id": "evt_[^"]+"/, `"id": "evt_transition_${tag}"`)
  const ok = await deliver(body)
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { result: 'applied' })
  for (const x of ['a', 'b', 'c']) {
    assert.deepEqual(await seq(db, `sq-${tag}${x}`), { status: 'stopped', stop_reason: 'policy_stop' }, `${engine}: cold sequence ${x} stopped`)
    assert.deepEqual(await msg(db, `h-${tag}${x}`), { status: 'skipped', error: 'policy_stop' })
  }
  assert.deepEqual(await enrollments(db, email), [{ tenant_id: S1, source: 'conversion:payment' }], `${engine}: only the opted-in seller transitions`)
  assert.deepEqual(await enrolledAudit(db, S1), [{ detail: 'conversion:payment' }])
  assert.deepEqual(await enrolledAudit(db, S2), [])
  assert.deepEqual(await enrolledAudit(db, S3), [], 'a withdrawn policy is no consent')
  assert.deepEqual(await enrollments(db, `x${email}`), [])
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM outreach_signal_context WHERE tenant_id IN (?, ?, ?)', [S1, S2, S3]), 3, 'attribution preserved')
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM suppressions WHERE lower(email) = ?', [email]), 0, 'not a marketing suppression')
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM lifecycle_events WHERE email = ? AND activated_at IS NOT NULL', [email]), 1)

  // Stripe redelivers: a duplicate; nothing re-enrolled, nothing resurrected.
  assert.deepEqual(await (await deliver(body)).json(), { result: 'duplicate' })
  assert.equal((await enrollments(db, email)).length, 1)
  assert.equal((await enrolledAudit(db, S1)).length, 1)
  assert.equal((await seq(db, `sq-${tag}a`))!.status, 'stopped')
  console.log('TRANSITION_WEBHOOK', engine, 'ok')
}

test('webhook on SQLite: a paid checkout stops every seller\'s cold work and transitions only the opted-in seller, once', async () => {
  await sqliteStore()
  await webhookScenario('sqlite')
})

test('webhook on Postgres: the same transition through the Db layer, no SQLite', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    setDb(pg)
    trapScanDb()
    assert.equal((await getDb()).kind, 'pg', 'engine canary')
    await webhookScenario('pg')
  } finally { await pg.close(); await s.drop() }
})
