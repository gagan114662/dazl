// #846 / #847: every account is capped per scan, per day and per month, from the environment with safe built-in defaults,
// never unlimited (lib/llm/spend-pool.ts windowCap / accountLimits), and an account without its own operator entry is
// reserved at the model transport (lib/scan/spend-cap.ts reserveScanSpend: inside a scan in the scan cap's own
// transaction; outside one through the account spend context ownerGuarded opens). Synthetic ids, stub costs, both
// engines for the store (SQLite in memory; Postgres when DAZL_TEST_PG_URL is set). No provider is called.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import {
  accountLimits, OWNER_DAY_CEILING_USD, OWNER_DAY_DEFAULT_USD, OWNER_MONTH_CEILING_USD, OWNER_MONTH_DEFAULT_USD, ownerLimits, poolRows, windowCap,
} from '../lib/llm/spend-pool.ts'
import { reserveScanSpend, runWithAccountSpend, runWithScanSpend, scanCapConfig, scanSpendCalls, scanSpendRow, type ScanSpendCtx } from '../lib/scan/spend-cap.ts'
import { bothEngines } from './helpers/engines.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const T0 = Date.UTC(2026, 10, 13, 12) / 1000
const refusedWith = (reason: string) => (e: unknown) => e instanceof SpendRefused && e.reason === reason
const rows = async (db: Db, owner: string) => (await poolRows(db, owner)).map(r => [r.period, Math.round(Number(r.reserved_usd) * 1e6) / 1e6, Math.round(Number(r.reported_usd) * 1e6) / 1e6, Number(r.calls)])

test('#846 #847 caps from env: missing -> built-in default; 0, negative, Infinity, NaN, text -> ignored (never unlimited); above the ceiling -> clamped; an account entry wins', () => {
  // Missing: the built-in defaults, for every account.
  assert.deepEqual(accountLimits(A, {}), { day: OWNER_DAY_DEFAULT_USD, month: OWNER_MONTH_DEFAULT_USD })
  assert.deepEqual([OWNER_DAY_DEFAULT_USD, OWNER_MONTH_DEFAULT_USD, OWNER_DAY_CEILING_USD, OWNER_MONTH_CEILING_USD], [10, 100, 100, 1000])
  assert.deepEqual(windowCap('day', A, {}), { usd: 10, source: 'default', env: 'DAZL_OWNER_DAY_MAX_USD', clamped: false, ignored: [] })
  // A deployment setting.
  assert.deepEqual(windowCap('day', A, { DAZL_OWNER_DAY_MAX_USD: '4.5' }), { usd: 4.5, source: 'env', env: 'DAZL_OWNER_DAY_MAX_USD', clamped: false, ignored: [] })
  assert.deepEqual(windowCap('month', A, { DAZL_OWNER_MONTH_MAX_USD: ' 40 ' }), { usd: 40, source: 'env', env: 'DAZL_OWNER_MONTH_MAX_USD', clamped: false, ignored: [] })
  // Anything that is not a positive finite number is not a limit: the default applies and the setting is reported.
  for (const bad of ['0', '-1', '-0', 'Infinity', '-Infinity', 'NaN', 'abc', ' ', '1e999', '0x', 'unlimited']) {
    for (const w of ['day', 'month'] as const) {
      const name = w === 'day' ? 'DAZL_OWNER_DAY_MAX_USD' : 'DAZL_OWNER_MONTH_MAX_USD'
      const c = windowCap(w, A, { [name]: bad })
      assert.deepEqual([c.usd, c.source, c.ignored], [w === 'day' ? 10 : 100, 'default', [name]], `${name}=${JSON.stringify(bad)}`)
    }
  }
  // Above the ceiling: clamped, so no setting can mean "unlimited".
  assert.deepEqual(windowCap('day', A, { DAZL_OWNER_DAY_MAX_USD: '1e9' }), { usd: 100, source: 'env', env: 'DAZL_OWNER_DAY_MAX_USD', clamped: true, ignored: [] })
  assert.deepEqual(windowCap('month', A, { DAZL_OWNER_MONTH_MAX_USD: '5000' }), { usd: 1000, source: 'env', env: 'DAZL_OWNER_MONTH_MAX_USD', clamped: true, ignored: [] })
  // The account's own entry wins (exact id), clamped too; a malformed entry falls to the deployment setting, then the default.
  const env = { DAZL_RUN_MAX_USD_USERS: `${A}:0.5,${B}:0`, DAZL_OWNER_MONTH_MAX_USD_USERS: `${A}:99999`, DAZL_OWNER_DAY_MAX_USD: '3' }
  assert.deepEqual(windowCap('day', A, env), { usd: 0.5, source: 'account', env: 'DAZL_RUN_MAX_USD_USERS', clamped: false, ignored: [] })
  assert.deepEqual(windowCap('month', A, env), { usd: 1000, source: 'account', env: 'DAZL_OWNER_MONTH_MAX_USD_USERS', clamped: true, ignored: [] })
  assert.deepEqual(windowCap('day', B, env), { usd: 3, source: 'env', env: 'DAZL_OWNER_DAY_MAX_USD', clamped: false, ignored: ['DAZL_RUN_MAX_USD_USERS'] })
  assert.deepEqual(windowCap('day', 'c'.repeat(32), env).source, 'env')
  // ownerLimits: only an account with a valid entry keeps the PooledGuard path, and its other window is never unlimited.
  assert.deepEqual(ownerLimits(A, { DAZL_RUN_MAX_USD_USERS: `${A}:2` }), { day: 2, month: 100 })
  assert.equal(ownerLimits(B, env), null, 'a 0 entry is not an entry: the default path (and default number) applies')
  assert.deepEqual(accountLimits(B, env), { day: 3, month: 100 })
})

test('#846 the per-scan cap: missing -> CAD 5 default; 0 or malformed -> every paid scan call refused (fails closed, never unlimited); higher -> clamped', () => {
  const c = scanCapConfig({})
  assert.ok(c.ok && Math.abs(c.capUsd - 5 / 1.5) < 1e-9)
  for (const bad of ['0', '-1', 'Infinity', 'abc']) assert.deepEqual(scanCapConfig({ DAZL_SCAN_CAP_CAD: bad }), { ok: false, reason: 'cap_config_invalid' }, bad)
  const hi = scanCapConfig({ DAZL_SCAN_CAP_CAD: '500' })
  assert.ok(hi.ok && hi.capCad === 5)
})

async function job(db: Db, id: string, tenant: string) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts) VALUES (?, ?, 'Biz', 'software', 'Toronto', 'running', 1)", [id, tenant])
}
const scanCtx = (db: Db, jobId: string, tenantId: string, o: Partial<ScanSpendCtx> = {}): ScanSpendCtx => ({ db, jobId, tenantId, attempt: 1, cap: scanCapConfig({}), clock: () => T0, ...o })

bothEngines('#846 inside a scan: a model call of an account without an entry reserves its day and month in the scan cap transaction; past the day cap it is refused owner_pool_limit, recorded, and the scan cap is untouched', async ({ db }) => {
  await job(db, 'j1', A)
  const ctx = scanCtx(db, 'j1', A, { accountLimits: { day: 0.5, month: 100 } })
  const h = await runWithScanSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.3))
  assert.ok(h)
  assert.deepEqual(await rows(db, A), [['d:2026-11-13', 0.3, 0, 1], ['m:2026-11', 0.3, 0, 1]])
  // Settled to the vendor-reported cost: every window moves with the scan's own ledger.
  await h!.settle(0.1)
  assert.deepEqual(await rows(db, A), [['d:2026-11-13', 0.1, 0.1, 1], ['m:2026-11', 0.1, 0.1, 1]])
  assert.equal((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.1)
  // 0.45 more would pass the 0.5 day cap: refused before any request, recorded as a refusal, the scan's cap unchanged.
  await assert.rejects(runWithScanSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.45)), refusedWith('owner_pool_limit'))
  assert.deepEqual(await rows(db, A), [['d:2026-11-13', 0.1, 0.1, 1], ['m:2026-11', 0.1, 0.1, 1]], 'nothing moved')
  assert.equal((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.1)
  assert.deepEqual((await scanSpendCalls(db, 'j1', A)).map(c => `${c.status}:${c.reason}`).sort(), ['refused:owner_pool_limit', 'settled:null'])
  // Not a model call (TinyFish, Apollo, PDL, render): the scan cap only, as before.
  await runWithScanSpend(ctx, () => reserveScanSpend('render', () => 0.45))
  assert.deepEqual(await rows(db, A), [['d:2026-11-13', 0.1, 0.1, 1], ['m:2026-11', 0.1, 0.1, 1]])
  // The scan's own cap refusing releases the windows it would have taken, in the same transaction.
  await assert.rejects(runWithScanSpend({ ...ctx, accountLimits: { day: 50, month: 100 } }, () => reserveScanSpend('llm.anthropic', () => 3.3)), refusedWith('over_cap'))
  assert.deepEqual(await rows(db, A), [['d:2026-11-13', 0.1, 0.1, 1], ['m:2026-11', 0.1, 0.1, 1]], 'released')
  // Tenant scope: B's windows are its own.
  await job(db, 'j2', B)
  await runWithScanSpend(scanCtx(db, 'j2', B, { accountLimits: { day: 0.5, month: 100 } }), () => reserveScanSpend('llm.openai', () => 0.45))
  assert.deepEqual(await rows(db, B), [['d:2026-11-13', 0.45, 0, 1], ['m:2026-11', 0.45, 0, 1]])
  // accountLimits null (the runner's own PooledGuard reserves instead): the transport leaves the pool alone, so no call counts twice.
  await job(db, 'j3', 'c'.repeat(32))
  await runWithScanSpend(scanCtx(db, 'j3', 'c'.repeat(32), { accountLimits: null }), () => reserveScanSpend('llm.anthropic', () => 0.2))
  assert.deepEqual(await rows(db, 'c'.repeat(32)), [])
})

bothEngines('#847 outside a scan: the month cap refuses across days while each day is under its own cap; the refusal writes nothing; a refused call is never sent', async ({ db }) => {
  const day = (d: number) => Date.UTC(2026, 10, d, 12) / 1000
  const at = (d: number, usd: number) => runWithAccountSpend({ db, tenantId: A, limits: { day: 0.5, month: 1 }, clock: () => day(d) }, () => reserveScanSpend('llm.anthropic', () => usd))
  for (const d of [1, 2]) await at(d, 0.45)
  await assert.rejects(at(3, 0.15), refusedWith('owner_pool_limit'))
  const r = await rows(db, A)
  assert.deepEqual(r, [['d:2026-11-01', 0.45, 0, 1], ['d:2026-11-02', 0.45, 0, 1], ['m:2026-11', 0.9, 0, 2]], 'no row for the 3rd: a refusal leaves the store as it was')
  // Still admitted when it fits (0.1 left in the month), and settled to the vendor's figure on every window.
  const h = await at(3, 0.1)
  await h!.settle(0.04)
  assert.deepEqual((await rows(db, A)).filter(x => String(x[0]).startsWith('m:')), [['m:2026-11', 0.94, 0.04, 3]])
  // A new month starts from zero.
  await runWithAccountSpend({ db, tenantId: A, limits: { day: 0.5, month: 1 }, clock: () => Date.UTC(2026, 11, 1, 12) / 1000 }, () => reserveScanSpend('llm.anthropic', () => 0.5))
  // Outside both contexts: no pool, as before (a test double, an eval).
  assert.equal(await reserveScanSpend('llm.anthropic', () => 0.5), null)
})

bothEngines('#846 a store that does not answer refuses the call (reservation_not_saved), on the account path too', async ({ db }) => {
  await db.run('ALTER TABLE tenant_spend_pools RENAME TO tenant_spend_pools_gone')
  try {
    await assert.rejects(runWithAccountSpend({ db, tenantId: A, limits: { day: 1, month: 2 } }, () => reserveScanSpend('llm.anthropic', () => 0.1)), refusedWith('reservation_not_saved'))
  } finally { await db.run('ALTER TABLE tenant_spend_pools_gone RENAME TO tenant_spend_pools') }
})
