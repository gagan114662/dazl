// Stripe end to end in test mode on Postgres, with two app instances and two tenants (test/helpers/pg-stripe-instance.mts):
// each instance starts checkout for its tenant (the tenant rides in client_reference_id and the subscription metadata),
// takes that tenant's signed test webhooks and reads /api/usage, while the other instance does the same for the other
// tenant. Then: one event delivered by both instances at once applies exactly once; each instance replays the other
// tenant's events (duplicates, nothing changes); and an event that names a tenant with the OTHER tenant's Stripe customer
// changes nothing. Tenant A's webhooks never change tenant B. Test mode only: api.stripe.com is a stub, no charge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const web = fileURLToPath(new URL('../', import.meta.url))
const id = () => randomBytes(4).toString('hex')
const A = { tag: 'a', TENANT: 'a'.repeat(28) + id(), CUSTOMER: 'cus_A' + id(), SUBSCRIPTION: 'sub_A' + id() }
const B = { tag: 'b', TENANT: 'b'.repeat(28) + id(), CUSTOMER: 'cus_B' + id(), SUBSCRIPTION: 'sub_B' + id() }
const SHARED = { tag: 's', TENANT: A.TENANT, CUSTOMER: A.CUSTOMER, SUBSCRIPTION: A.SUBSCRIPTION } // the raced event is A's
const webhook = 'whsec_test' + randomBytes(8).toString('hex')

type Out = { tag: string; checkout: { status: number; form: Record<string, string> }; completed: { status: number; result?: string }; failed: { status: number; result?: string }; race: { status: number; result?: string }; replays: { status: number; result?: string }[]; forged: { status: number; result?: string }; usage: { plan: string; scan_limit: number | null; billing_status: string | null } }
const instance = async (schema: string, me: typeof A, other: typeof A) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ST_WEBHOOK: webhook, ST_SCHEMA: schema, ST_ME: JSON.stringify(me), ST_OTHER: JSON.stringify(other), ST_SHARED: JSON.stringify(SHARED) }
  delete e.NODE_TEST_CONTEXT; delete e.DATABASE_URL
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', './test/helpers/pg-stripe-instance.mts'],
    { cwd: web, env: e, encoding: 'utf8', timeout: 120_000 })
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Out
}

test('[pg] Stripe test mode, two instances, two tenants: checkout -> signed webhook -> plan -> /api/usage, and A\'s webhooks never change B', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    await db.run('CREATE TABLE st_barrier (phase TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (phase, tag))')
    const [a, b] = await Promise.all([instance(s.schema, A, B), instance(s.schema, B, A)])
    for (const [o, me] of [[a, A], [b, B]] as const) {
      // checkout carries this tenant, in test mode
      assert.equal(o.checkout.status, 200)
      assert.deepEqual([o.checkout.form.mode, o.checkout.form.client_reference_id, o.checkout.form['subscription_data[metadata][tenant_id]'], o.checkout.form['line_items[0][price]']], ['subscription', me.TENANT, me.TENANT, 'price_fixture_pro'])
      assert.deepEqual([o.completed, o.failed], [{ status: 200, result: 'applied' }, { status: 200, result: 'applied' }])
      // the other tenant's events, replayed on this instance: duplicates
      assert.deepEqual(o.replays, [{ status: 200, result: 'duplicate' }, { status: 200, result: 'duplicate' }])
      // this tenant's id with the other tenant's customer: ignored
      assert.deepEqual(o.forged, { status: 200, result: 'ignored' })
      // /api/usage on the instance that served this tenant: Pro, Stripe retrying the failed payment
      assert.deepEqual(o.usage, { ...o.usage, plan: 'pro', scan_limit: null, billing_status: 'past_due' })
    }
    // one event delivered by both instances at once is processed exactly once: one instance processes it, the other
    // waits on its event row and reports duplicate. (It repeats A's checkout and is older than A's payment failure,
    // so the one that processes it finds it stale: nothing changes either way.)
    const raced = [a.race.result, b.race.result]
    assert.equal(raced.filter(r => r === 'duplicate').length, 1, JSON.stringify(raced))
    assert.ok(raced.some(r => r === 'stale' || r === 'applied'), JSON.stringify(raced))
    // the rows: each tenant its own customer and subscription, Pro and past_due; no customer shared
    const rows = await db.all<{ tenant_id: string; plan: string; stripe_customer_id: string; stripe_subscription_id: string; subscription_status: string }>(
      'SELECT tenant_id, plan, stripe_customer_id, stripe_subscription_id, subscription_status FROM tenant_plans ORDER BY tenant_id')
    assert.deepEqual(rows, [
      { tenant_id: A.TENANT, plan: 'pro', stripe_customer_id: A.CUSTOMER, stripe_subscription_id: A.SUBSCRIPTION, subscription_status: 'past_due' },
      { tenant_id: B.TENANT, plan: 'pro', stripe_customer_id: B.CUSTOMER, stripe_subscription_id: B.SUBSCRIPTION, subscription_status: 'past_due' },
    ])
    // every event recorded once: 2 per tenant, the 2 forged ones (recorded as processed, changed nothing), the raced one
    const events = (await db.all<{ id: string }>('SELECT id FROM stripe_events ORDER BY id')).map(r => r.id)
    assert.deepEqual(events, ['evt_a_co', 'evt_a_forged', 'evt_a_pf', 'evt_b_co', 'evt_b_forged', 'evt_b_pf', 'evt_shared_race'])
  } finally { await db.close(); await s.drop() }
})
