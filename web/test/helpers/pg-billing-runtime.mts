// Runs the billing path on a fresh Postgres schema with two tenants (see test/pg-billing.test.ts). Stubbed: no network.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setUser } from './tenant-route-db.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { readPlan, savePlan, readBillingStatus, readScanQuota, monthStartS, PLAN_LIMITS } from '../../lib/plans.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call to ${String(u)}`) }) as typeof fetch
const A = 'a'.repeat(32), B = 'b'.repeat(32)

test('billing on Postgres, two tenants', async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    setDb(db)
    // The routes read the CURRENT UTC month (lib/plans.ts monthStartS) from the in-process JS clock; the whole billing
    // path (fixtures and both route handlers) shares it, so freezing Date at one instant keeps fixture and routes in the
    // same month with no boundary race and no sleeping into the next month. Only Date is mocked - real timers stay live.
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const now = new Date()
    const month = monthStartS(now)
    // plans: A on Pro and past_due, B on Free (no row)
    await savePlan(db, A, 'pro')
    await db.run("UPDATE tenant_plans SET subscription_status = 'past_due', stripe_customer_id = 'cus_a' WHERE tenant_id = ?", [A])
    assert.equal(await readPlan(db, A), 'pro')
    assert.equal(await readPlan(db, B), 'free')
    assert.equal(await readBillingStatus(db, A), 'past_due')
    assert.equal(await readBillingStatus(db, B), null)
    // a second write for A changes A only; B's own row is its own
    await savePlan(db, B, 'free')
    await savePlan(db, A, 'pro')
    assert.deepEqual(await db.all('SELECT tenant_id, plan, stripe_customer_id FROM tenant_plans ORDER BY tenant_id'), [{ tenant_id: A, plan: 'pro', stripe_customer_id: 'cus_a' }, { tenant_id: B, plan: 'free', stripe_customer_id: null }])

    // scans this month: A 3 counted; B 1 counted (+ a genuine failure and a trial scan, neither counted, + last month)
    const job = (t: string, at: number, status = 'done', error: string | null = null, funded = 'user') => db.run(
      'INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, funded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [Math.random().toString(16).slice(2).padEnd(24, '0').slice(0, 24), t, 'b', 'i', 'l', status, error, funded, at])
    for (let i = 0; i < 3; i++) await job(A, month + 10 + i)
    await job(B, month + 10)
    await job(B, month + 11, 'failed', 'provider_error')
    await job(B, month + 12, 'done', null, 'trial')
    await job(B, month - 100)
    assert.deepEqual(await readScanQuota(db, A, now), { plan: 'pro', used: 3, limit: null, allowed: true })
    assert.deepEqual(await readScanQuota(db, B, now), { plan: 'free', used: 1, limit: PLAN_LIMITS.free.scansPerMonth, allowed: true })

    // AI usage accounting: A has two attempts, B one
    for (const [t, model] of [[A, 'model-a1'], [A, 'model-a2'], [B, 'model-b1']]) await db.run(
      "INSERT INTO outreach_llm_usage (tenant_id, purpose, vendor, model, outcome, input_tokens, output_tokens, created_at) VALUES (?, 'polish', 'anthropic', ?, 'ok', 10, 20, ?)", [t, model, month + 50])

    // the routes, signed in as each tenant
    const usage = await import('../../app/api/usage/route.ts')
    const llm = await import('../../app/api/outreach/usage/route.ts')
    const { NextRequest } = await import('next/server')
    const req = () => new NextRequest('https://app.dazl.test/api/usage', { headers: { 'x-forwarded-for': '203.0.113.9' } })
    const seen: Record<string, { usage: Record<string, unknown>; llm: { attempts: { model: string }[]; total: number } }> = {}
    for (const t of [A, B]) {
      setUser({ id: t, business_name: t.slice(0, 1) })
      seen[t] = { usage: await (await usage.GET(req())).json(), llm: await (await llm.GET()).json() }
    }
    assert.deepEqual([seen[A].usage.plan, seen[A].usage.billing_status, seen[A].usage.scan_limit], ['pro', 'past_due', null])
    assert.deepEqual([seen[B].usage.plan, seen[B].usage.billing_status, seen[B].usage.scan_limit, seen[B].usage.scans_used], ['free', null, 50, 1])
    assert.equal(seen[A].llm.total, 2)
    assert.deepEqual(seen[A].llm.attempts.map(x => x.model).sort(), ['model-a1', 'model-a2'])
    assert.equal(seen[B].llm.total, 1)
    assert.deepEqual(seen[B].llm.attempts.map(x => x.model), ['model-b1'])
    assert.ok(!JSON.stringify(seen[B]).includes('model-a') && !JSON.stringify(seen[B]).includes('cus_a') && !JSON.stringify(seen[B]).includes('past_due'))
    assert.ok(!JSON.stringify(seen[A]).includes('model-b'))
    console.log('PG_BILLING ok')
  } finally { mock.timers.reset(); await db.close(); await s.drop() }
})
