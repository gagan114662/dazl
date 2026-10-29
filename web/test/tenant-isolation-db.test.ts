// Tenant isolation at the store, on both SQLite and Postgres (docs/PLATFORM.md step 4).
// 1. Every table is tenant-scoped: it has its own tenant column, or it hangs off a parent that has one, or it is
//    listed here as global with a reason. A new table without any of these fails on both engines.
// 2. The modules already on the Db layer (sessions, password sign-in, Google sign-in, billing) keep two tenants apart
//    on both engines. Modules still on raw SQLite are covered through their routes (tenant-isolation-manifest.test.ts).
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { createPasswordUser, createSession, deleteSession, findPasswordUser, getSessionUser } from '../lib/auth-db.ts'
import { resolveUser } from '../lib/auth-google.ts'
import { applyStripeEvent, createCheckoutUrl, createPortalUrl } from '../lib/billing/stripe.ts'
import { readPlan } from '../lib/plans.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { bothEngines } from './helpers/engines.ts'

import { NOT_DIRECT, TENANT_COLUMNS } from './helpers/tenant-tables.ts'

async function columns(db: Db): Promise<Map<string, string[]>> {
  const rows = db.kind === 'pg'
    ? await db.all<{ t: string; c: string }>("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'dazl_schema_migrations'")
    : await db.all<{ t: string; c: string }>("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'")
  const out = new Map<string, string[]>()
  for (const r of rows) out.set(r.t, [...(out.get(r.t) ?? []), r.c])
  return out
}

bothEngines('every table is tenant-scoped: its own tenant column, a tenant-scoped parent, or listed as global', async ({ db }) => {
  const cols = await columns(db)
  assert.ok(cols.size >= 72)
  const scoped = (t: string) => (cols.get(t) ?? []).some(c => TENANT_COLUMNS.includes(c))
  const missing = [...cols.keys()].filter(t => !scoped(t) && !(t in NOT_DIRECT)).sort()
  assert.deepEqual(missing, [], 'new table without a tenant column: add tenant_id, or list it in NOT_DIRECT with a reason')
  for (const [t, how] of Object.entries(NOT_DIRECT)) {
    assert.ok(cols.has(t), `${t} is listed but does not exist`)
    assert.ok(!scoped(t), `${t} has a tenant column now: remove it from NOT_DIRECT`)
    if ('via' in how) {
      const [col, parent] = how.via
      assert.ok(cols.get(t)!.includes(col), `${t}.${col} missing`)
      // the parent must itself be tenant-scoped (directly, or one more hop: lead_sources -> leads -> scan_jobs)
      const p = NOT_DIRECT[parent]
      assert.ok(scoped(parent) || (p && 'via' in p && scoped(p.via[1])), `${t} -> ${parent} is not tenant-scoped`)
    }
  }
})

const userRow = (id: string, email: string) => ({ id, email, name: id, business_name: `Biz ${id}`, password_hash: `hash-${id}`, salt: `salt-${id}` })

bothEngines("sessions and sign-in: each token resolves only to its own tenant; one tenant's sign-out leaves the other's session", async ({ db }) => {
  await createPasswordUser(userRow('A', 'a@example.test'), db)
  await createPasswordUser(userRow('B', 'b@example.test'), db)
  // B cannot take A's email (and so A's account)
  assert.equal(await createPasswordUser({ ...userRow('B2', 'a@example.test') }, db), 'exists')
  assert.deepEqual(await findPasswordUser('a@example.test', db), { id: 'A', password_hash: 'hash-A', salt: 'salt-A' })
  const ta = await createSession('A', db), tb = await createSession('B', db)
  assert.equal((await getSessionUser(ta, db))?.id, 'A')
  assert.equal((await getSessionUser(tb, db))?.id, 'B')
  await deleteSession(ta, db)
  assert.equal(await getSessionUser(ta, db), null)
  assert.equal((await getSessionUser(tb, db))?.id, 'B')
})

bothEngines("Google sign-in: B's Google identity carrying A's email never reaches A's account", async ({ db }) => {
  await createPasswordUser(userRow('A', 'a@example.test'), db)
  assert.deepEqual(await resolveUser(db, { sub: 'google-b', email: 'a@example.test', name: 'B' }), { error: 'email_exists' })
  assert.equal(await db.get("SELECT 1 AS x FROM oauth_identities WHERE subject = 'google-b'"), undefined)
  const b = await resolveUser(db, { sub: 'google-b', email: 'b@example.test', name: 'B' })
  assert.ok('user_id' in b && b.user_id !== 'A')
})

bothEngines("billing: a Stripe event for one tenant changes only that tenant's plan; checkout and portal use only the caller's own customer", async ({ db }) => {
  const checkout = (id: string, tenant: string, customer: string) => applyStripeEvent(db, { id, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: tenant, customer, subscription: `sub_${tenant}` } } })
  await checkout('evt_a', 'A', 'cus_A')
  assert.equal(await readPlan(db, 'A'), 'pro')
  assert.equal(await readPlan(db, 'B'), 'free')
  await checkout('evt_b', 'B', 'cus_B')
  // a cancellation found by A's customer id downgrades A only
  await applyStripeEvent(db, { id: 'evt_a_del', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_A' } } })
  assert.equal(await readPlan(db, 'A'), 'free')
  assert.equal(await readPlan(db, 'B'), 'pro')
  const bodies: string[] = []
  const f = (async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response(JSON.stringify({ url: 'https://stripe.test/x' })) }) as unknown as typeof fetch
  await createPortalUrl(db, 'B', f)
  await createCheckoutUrl(db, 'B', 'b@example.test', f)
  assert.ok(bodies.every(b => b.includes('cus_B') && !b.includes('cus_A')), bodies.join(' | '))
  assert.equal(await createPortalUrl(db, 'C', f), null) // a tenant with no customer gets no portal, never someone else's
})

// rate_limits is global (no tenant column), but the routes key every per-tenant limit by tenant id. One tenant using up
// its allowance must never spend or block another's, on either engine.
bothEngines("rate limits: tenant A using up its allowance never spends or blocks tenant B's", async ({ db, kind }) => {
  const now = 1_800_000_000_000
  const A = `${kind}-${'a'.repeat(32)}`, B = `${kind}-${'b'.repeat(32)}`
  for (let i = 0; i < 3; i++) assert.equal((await rateLimit(`scan:${A}`, 3, 3_600_000, db, now + i)).ok, true)
  assert.equal((await rateLimit(`scan:${A}`, 3, 3_600_000, db, now + 10)).ok, false) // A is out
  for (let i = 0; i < 3; i++) assert.equal((await rateLimit(`scan:${B}`, 3, 3_600_000, db, now + 20 + i)).ok, true) // B has its full 3
  assert.equal((await rateLimit(`scan:${B}`, 3, 3_600_000, db, now + 30)).ok, false)
  const rows = await db.all<{ key: string; count: number }>('SELECT key, count FROM rate_limits WHERE key IN (?, ?) ORDER BY key', [`scan:${A}`, `scan:${B}`])
  assert.deepEqual(rows.map(r => [r.key, Number(r.count)]), [[`scan:${A}`, 4], [`scan:${B}`, 4]])
})
