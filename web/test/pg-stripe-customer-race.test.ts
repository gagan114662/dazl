// One Stripe customer is one tenant's, even under a race (lib/billing/stripe.ts applyStripeEvent): two DIFFERENT signed
// events (distinct ids, so the stripe_events dedup does not serialize them), each naming a different tenant and the
// SAME customer no tenant has yet, applied at the same moment from separate Postgres pools (two app instances). Exactly
// one tenant gets the customer; the other event changes nothing and is logged as customer_conflict. Repeated, because a
// race that loses once proves little. Also: a customer two tenants already share (rows from before this check) stays
// refused for both. Test mode fixtures only: no Stripe call, no charge.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { applyStripeEvent, type StripeEvent } from '../lib/billing/stripe.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const hex = (n = 4) => randomBytes(n).toString('hex')
const completed = (tenant: string, customer: string): StripeEvent => ({
  id: `evt_race_${hex(6)}`, type: 'checkout.session.completed', created: 1793000000,
  data: { object: { object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: tenant, customer, subscription: `sub_${hex()}`, metadata: {} } },
} as StripeEvent)
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((c: string | Uint8Array, ...r: unknown[]) => String(c).includes('"type":"stripe_event"') ? true : (write as (c: unknown, ...r: unknown[]) => boolean)(c, ...r)) as typeof process.stdout.write
  try { return await f() } finally { process.stdout.write = write }
}

test('[pg] two distinct events, two tenants, one unbound customer, at the same moment on two pools: exactly one tenant gets it', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const admin = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  const one = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 }), two = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  try {
    await runPgMigrations(admin.pool)
    for (let i = 0; i < 25; i++) {
      const A = 'a'.repeat(24) + hex(), B = 'b'.repeat(24) + hex(), customer = `cus_race_${hex()}`
      const results = await quiet(() => Promise.all([applyStripeEvent(one, completed(A, customer)), applyStripeEvent(two, completed(B, customer))]))
      const owners = await admin.all<{ tenant_id: string }>('SELECT tenant_id FROM tenant_plans WHERE stripe_customer_id = ?', [customer])
      assert.equal(owners.length, 1, `iteration ${i}: the customer is bound to ${owners.length} tenants (${JSON.stringify(results)})`)
      assert.deepEqual([...results].sort(), ['applied', 'ignored'], `iteration ${i}`)
      const winner = results[0] === 'applied' ? A : B, loser = winner === A ? B : A
      assert.equal(owners[0].tenant_id, winner)
      const lost = await admin.get<{ plan: string; stripe_customer_id: string | null }>('SELECT plan, stripe_customer_id FROM tenant_plans WHERE tenant_id = ?', [loser])
      assert.ok(!lost || (lost.plan !== 'pro' && lost.stripe_customer_id === null), `iteration ${i}: the losing tenant changed: ${JSON.stringify(lost)}`)
    }
  } finally { await Promise.all([one.close(), two.close(), admin.close()]); await s.drop() }
})

test('[pg] a customer two tenants already share (rows from before the check) stays refused for both', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    const A = 'a'.repeat(32), B = 'b'.repeat(32), customer = `cus_dup_${hex()}`
    for (const t of [A, B]) await db.run("INSERT INTO tenant_plans (tenant_id, plan, stripe_customer_id) VALUES (?, 'free', ?)", [t, customer])
    const before = JSON.stringify(await db.all('SELECT * FROM tenant_plans ORDER BY tenant_id'))
    assert.deepEqual(await quiet(() => Promise.all([applyStripeEvent(db, completed(A, customer)), applyStripeEvent(db, completed(B, customer))])), ['ignored', 'ignored'])
    assert.equal(JSON.stringify(await db.all('SELECT * FROM tenant_plans ORDER BY tenant_id')), before, 'neither tenant changed')
  } finally { await db.close(); await s.drop() }
})
