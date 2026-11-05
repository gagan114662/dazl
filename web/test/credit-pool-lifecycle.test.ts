// Credit records (lib/enrich/credit-pool.ts) live in tenant_spend_pools beside the USD pools. Review of #594 (F5): the
// tenant export must show them as labelled credit records (never credits or an epoch as USD, never a provider as a call
// count), keep every value, leave USD numbers untouched, and the current deletion scope must still erase them.
// Synthetic tenants, both engines, no network.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { tenantFixture } from './helpers/tenant-fixture.ts'
import { exportTenant, deleteTenant } from '../lib/tenant/lifecycle.ts'
import { reserveCredits, settleCredits, setCreditLimit } from '../lib/enrich/credit-pool.ts'
import { poolRows, periodOf } from '../lib/llm/spend-pool.ts'

const A = 'credlife-aaaa', B = 'credlife-bbbb', NOW = 1_900_000_000
const T0 = Date.UTC(2026, 10, 2, 12) / 1000
const num = (v: unknown) => Number(v)

bothEngines('credit export: labelled credit units/provider/window/time, every value kept, USD pools untouched, other tenant absent', async c => {
  const f = await tenantFixture(c, [[A, 'ca'], [B, 'cb']])
  await setCreditLimit(c.db, A, 'pdl', 'month', 40)
  const open = await reserveCredits(c.db, A, 'pdl', 3, { now: T0, env: {} })      // stays unsettled
  const done = await reserveCredits(c.db, A, 'apollo', 2, { now: T0, env: {} })
  await settleCredits(c.db, done, 1)
  await reserveCredits(c.db, B, 'pdl', 7, { now: T0, env: {} })
  const usdBefore = (await poolRows(c.db, A)).filter(r => /^[dmpl]:/.test(String(r.period)))
  const e = await exportTenant(c.db, A, new Date(NOW * 1000))
  const rows = (e.tables.tenant_spend_pools ?? []) as Record<string, unknown>[]
  const by = (k: string) => rows.filter(r => r.record === k)
  assert.deepEqual(by('credit_limit').map(r => [r.provider, r.window, r.limit_credits]), [['pdl', 'month', 40]])
  const hold = by('credit_hold')
  assert.equal(hold.length, 1, 'the unsettled hold is exported, not dropped')
  assert.equal(hold[0].provider, 'pdl'); assert.equal(hold[0].reserved_credits, 3)
  assert.equal(hold[0].reserved_at, new Date(T0 * 1000).toISOString(), 'epoch translated to a time, not shown as dollars')
  assert.equal(hold[0].hold_id, open.id)
  const usage = by('credit_usage').map(r => [r.provider, r.window, r.window_start, r.reserved_credits, r.charged_credits]).sort()
  assert.deepEqual(usage, [['apollo', 'day', '20261102', 1, 1], ['apollo', 'month', '202611', 1, 1], ['pdl', 'day', '20261102', 3, 0], ['pdl', 'month', '202611', 3, 0]])
  for (const r of rows.filter(x => x.record)) for (const k of ['reserved_usd', 'reported_usd', 'calls', 'period']) assert.ok(!(k in r), `${k} not exposed on a credit record`)
  for (const k of ['tenant_spend_pools.reserved_usd', 'tenant_spend_pools.reported_usd', 'tenant_spend_pools.calls']) assert.ok(e.redacted_columns.includes(k), `${k} disclosed as translated`)
  assert.ok(!JSON.stringify(e).includes(`"${B}"`), 'nothing of the other tenant')
  assert.deepEqual((await poolRows(c.db, A)).filter(r => /^[dmpl]:/.test(String(r.period))), usdBefore, 'USD pool rows unchanged by the credit work')
})

bothEngines('credit rows do not change the USD estimate or funnel numbers (the readers select only their own periods)', async c => {
  await tenantFixture(c, [[A, 'ca']])
  const usd = async () => ({
    est: num((await poolRows(c.db, A)).find(r => r.period === periodOf('month', T0))?.reserved_usd ?? 0),
    funnel: num((await c.db.get<{ usd: unknown }>("SELECT coalesce(sum(reported_usd), 0) AS usd FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE 'm:%'", [A]))!.usd),
  })
  const before = await usd()
  await setCreditLimit(c.db, A, 'pdl', 'day', 9)
  const h = await reserveCredits(c.db, A, 'pdl', 4, { now: T0, env: {} })
  await reserveCredits(c.db, A, 'apollo', 1, { now: T0, env: {} })
  assert.deepEqual(await usd(), before, 'credit usage, limit and open hold rows move neither number')
  await settleCredits(c.db, h, 4)
  assert.deepEqual(await usd(), before)
})

bothEngines('current deletion scope is unchanged: credit limit, usage and an unsettled hold are erased with the tenant, the other tenant is byte-identical', async c => {
  const f = await tenantFixture(c, [[A, 'ca'], [B, 'cb']])
  for (const t of [A, B]) { await setCreditLimit(c.db, t, 'pdl', 'month', 40); await reserveCredits(c.db, t, 'pdl', 3, { now: T0, env: {} }) }
  const bBefore = await f.snap(B)
  assert.equal((await deleteTenant(c.db, A, { policy: { suppressions: 'retain' }, requestedBy: 'operator (synthetic credit test)', now: NOW })).state, 'completed')
  assert.equal(num((await c.db.get<{ n: unknown }>('SELECT count(*) AS n FROM tenant_spend_pools WHERE tenant_id = ?', [A]))!.n), 0)
  assert.deepEqual(await f.snap(B), bBefore)
  assert.ok(num((await c.db.get<{ n: unknown }>('SELECT count(*) AS n FROM tenant_spend_pools WHERE tenant_id = ?', [B]))!.n) >= 4)
})
