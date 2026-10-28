// Stripe test mode through to the plan gates (test/billing-plan-gates.test.ts): the plan a signed webhook writes in the
// shared store (getDb(): a separate SQLite file here, or Postgres) is the plan the scan routes enforce. The routes' own
// scan store is a different SQLite handle holding a deliberately stale plan, so a gate that still read the plan from
// it would fail. The monthly scan count still comes from that scan store, where the route writes scans. Signed
// fixture events, api.stripe.com never called, the scan runner never started (after() is recorded, not run).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture_pro'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const { setDb, sqliteDb, pgDb } = await import('../../lib/db/client.ts')
const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
const { runPgMigrations } = await import('../../lib/db/migrate-pg.ts')
const { saveKey } = await import('../../lib/llm/key-store.ts')
const { PLAN_LIMITS, setPlan } = await import('../../lib/plans.ts')
const webhook = await import('../../app/api/billing/webhook/route.ts')
const scan = await import('../../app/api/scan/route.ts')
const csv = await import('../../app/api/scan/csv/route.ts')
const usage = await import('../../app/api/usage/route.ts')
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call to ${String(u)}`) }) as typeof fetch

const fixture = (name: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}` }
const deliver = async (body: string) => (await webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) } }))).json()
const post = (path: string, body: unknown) => new NextRequest(`https://dazl.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } })
const startScan = async () => { const r = await scan.POST(post('/api/scan', { query: 'companies hiring sales reps in Toronto' })); return { status: r.status, body: await r.json() } }
const importCsv = async () => { const r = await csv.POST(post('/api/scan/csv', { csv: 'acme-dental-fixture.com\nbeta-roofing-fixture.com\n' })); return { status: r.status, body: await r.json() } }
const account = async () => { const u = await (await usage.GET(new NextRequest('https://dazl.test/api/usage'))).json() as { plan: string; scan_limit: number | null; billing_status: string | null }; return { plan: u.plan, scan_limit: u.scan_limit, billing_status: u.billing_status } }

async function scenario(engine: string, shared: Awaited<ReturnType<typeof import('../../lib/db/client.ts').getDb>>) {
  // the routes' scan store: its own SQLite handle, NOT the shared store
  const scanStore = new Database(':memory:'); migrateAllSqlite(scanStore)
  setScanDb(scanStore)   // also points getDb() at it...
  setDb(shared)          // ...so point getDb() back at the shared store, where billing reads and writes
  const T = 'e'.repeat(32), OTHER = 'f'.repeat(32)
  setUser({ id: T, business_name: 'Acme', email: 'owner@example.test' } as never)
  saveKey(scanStore, T, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
  // this month's Free allowance used up, in the scan store (where the route writes scans); none in the shared store
  const limit = PLAN_LIMITS.free.scansPerMonth!
  const ins = scanStore.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'Acme', 'software', 'Toronto')")
  for (let i = 0; i < limit; i++) ins.run(`done${String(i).padStart(20, '0')}`, T)
  scanStore.prepare("UPDATE scan_jobs SET status = 'running' WHERE user_id = ?").run(T)
  scanStore.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ?").run(T)
  // scans the route queued end before the next step (the runner is never started here)
  const finishScans = () => { scanStore.prepare("UPDATE scan_jobs SET status = 'running' WHERE user_id = ? AND status = 'pending'").run(T); scanStore.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ? AND status = 'running'").run(T) }
  // another tenant is Pro in the shared store: never this tenant's plan
  await shared.run("INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, 'pro')", [OTHER])

  // 1. The scan store says Pro (stale); the shared store says nothing (Free): the gates follow the shared store
  setPlan(scanStore, T, 'pro')
  assert.deepEqual(await account(), { plan: 'free', scan_limit: limit, billing_status: null })
  const refused = await startScan()
  assert.deepEqual([refused.status, refused.body.error], [402, 'quota_exceeded'], 'Free at its limit, counted where the scans are')
  assert.equal((await importCsv()).status, 402, 'CSV import is Pro only')

  // 2. Signed checkout webhook -> Pro in the shared store; the scan store now says Free (stale): the scan is accepted
  const vars = { TENANT: T, CUSTOMER: 'cus_gates' + engine, SUBSCRIPTION: 'sub_gates' + engine }
  assert.deepEqual(await deliver(fixture('checkout.session.completed', vars)), { result: 'applied' })
  setPlan(scanStore, T, 'free')
  assert.deepEqual(await account(), { plan: 'pro', scan_limit: null, billing_status: 'active' })
  const accepted = await startScan()
  assert.ok(accepted.status < 300 && typeof accepted.body.job_id === 'string', JSON.stringify(accepted))
  setPlan(scanStore, T, 'pro') // csv-import's per-row quota (lib/scan) still reads the scan store: keep it agreeing here
  const imported = await importCsv()
  assert.ok(imported.status < 300 && typeof imported.body.batch_id === 'string', JSON.stringify(imported))

  finishScans()
  // 3. Payment failed: Stripe retries, still Pro, billing status past_due; the gates still allow
  assert.deepEqual(await deliver(fixture('invoice.payment_failed', vars)), { result: 'applied' })
  setPlan(scanStore, T, 'free')
  assert.deepEqual(await account(), { plan: 'pro', scan_limit: null, billing_status: 'past_due' })
  const again = await startScan()
  assert.ok(again.status < 300, JSON.stringify(again))

  finishScans()
  // 4. Cancellation: subscription deleted -> Free; the scan store says Pro (stale): refused again
  assert.deepEqual(await deliver(fixture('customer.subscription.deleted', vars)), { result: 'applied' })
  setPlan(scanStore, T, 'pro')
  assert.deepEqual(await account(), { plan: 'free', scan_limit: limit, billing_status: 'canceled' })
  assert.equal((await startScan()).status, 402)
  assert.equal((await importCsv()).status, 402)
  assert.equal((await shared.get<{ plan: string }>('SELECT plan FROM tenant_plans WHERE tenant_id = ?', [OTHER]))!.plan, 'pro', 'the other tenant untouched')
  scanStore.close()
  console.log('PLAN_GATES', engine)
}

test('plan gates follow Stripe through the shared store: SQLite (separate file)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  await scenario('sqlite', sqliteDb(raw))
})

test('plan gates follow Stripe through the shared store: Postgres', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try { await runPgMigrations(pg.pool); await scenario('pg', pg) } finally { await pg.close(); await s.drop() }
})
