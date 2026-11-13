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
import { reserveScanSpend, runWithAccountSpend, runWithoutAccountSpend, runWithScanSpend, scanCapConfig, scanSpendCalls, scanSpendRow, type ScanSpendCtx } from '../lib/scan/spend-cap.ts'
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
  assert.deepEqual(windowCap('day', A, { DAZL_OWNER_DAY_MAX_USD: '1000000' }), { usd: 100, source: 'env', env: 'DAZL_OWNER_DAY_MAX_USD', clamped: true, ignored: [] })
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

test('#846 review R7: only plain decimals count (0x10, 1e2, +5 are not limits: the default applies); in an account list the first VALID entry wins', () => {
  for (const bad of ['0x10', '1e2', '+5', '5e-1', '٥', '1_000']) {
    assert.deepEqual([windowCap('day', A, { DAZL_OWNER_DAY_MAX_USD: bad }).usd, windowCap('day', A, { DAZL_OWNER_DAY_MAX_USD: bad }).source], [10, 'default'], bad)
    assert.equal(windowCap('month', A, { DAZL_OWNER_MONTH_MAX_USD_USERS: `${A}:${bad}` }).source, 'default', `entry ${bad}`)
  }
  assert.deepEqual(windowCap('day', A, { DAZL_RUN_MAX_USD_USERS: `${A}:0,${A}:5` }), { usd: 5, source: 'account', env: 'DAZL_RUN_MAX_USD_USERS', clamped: false, ignored: [] })
  assert.deepEqual(windowCap('day', A, { DAZL_RUN_MAX_USD_USERS: `${A}:0x10,${A}:2.5` }).usd, 2.5)
  assert.deepEqual(ownerLimits(A, { DAZL_RUN_MAX_USD_USERS: `${A}:abc,${A}:1` }), { day: 1, month: 100 })
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
const scanCtx = (db: Db, jobId: string, tenantId: string, o: Partial<ScanSpendCtx> = {}): ScanSpendCtx => ({ db, jobId, tenantId, attempt: 1, cap: scanCapConfig({}), accountLimits: null, clock: () => T0, ...o })

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
  // #846 review R2: outside a scan and an account, a model call is refused (fails closed); only the named escape hatch
  // (offline evals, test doubles) passes, and a non-model kind outside a scan is ungated as before.
  await assert.rejects(reserveScanSpend('llm.anthropic', () => 0.5), refusedWith('no_spend_context'))
  await assert.rejects(reserveScanSpend('llm.openai', () => 0.5), refusedWith('no_spend_context'))
  assert.equal(await runWithoutAccountSpend('test', () => reserveScanSpend('llm.anthropic', () => 0.5)), null)
  assert.equal(await reserveScanSpend('render', () => 0.5), null)
  // An operator-named account (limits null: its PooledGuard reserved): the transport adds nothing.
  assert.equal(await runWithAccountSpend({ db, tenantId: B, limits: null }, () => reserveScanSpend('llm.anthropic', () => 0.5)), null)
  assert.deepEqual(await rows(db, B), [])
})

bothEngines('#846 a store that does not answer refuses the call (reservation_not_saved), on the account path too', async ({ db }) => {
  await db.run('ALTER TABLE tenant_spend_pools RENAME TO tenant_spend_pools_gone')
  try {
    await assert.rejects(runWithAccountSpend({ db, tenantId: A, limits: { day: 1, month: 2 } }, () => reserveScanSpend('llm.anthropic', () => 0.1)), refusedWith('reservation_not_saved'))
  } finally { await db.run('ALTER TABLE tenant_spend_pools_gone RENAME TO tenant_spend_pools') }
})

// #846 review R4: concurrent reservations of one account on the transport path never pass its cap together: N racing
// reservations of 0.3 against a day cap of 1 admit at most 3, and the stored total stays <= 1. Both engines (Postgres
// in CI), plus two SQLite connections to one file as two instances.
bothEngines('#846 review R4: racing reservations of one account admit at most the cap', async ({ db }) => {
  const one = () => runWithAccountSpend({ db, tenantId: A, limits: { day: 1, month: 10 }, clock: () => T0 }, () => reserveScanSpend('llm.anthropic', () => 0.3))
  const out = await Promise.allSettled(Array.from({ length: 12 }, one))
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 3)
  for (const o of out) if (o.status === 'rejected') assert.ok(refusedWith('owner_pool_limit')(o.reason), String(o.reason))
  const [d] = await rows(db, A)
  assert.ok((d[1] as number) <= 1 + 1e-9 && d[3] === 3, JSON.stringify(d))
})
test('#846 review R4: two SQLite connections to one file (two instances) racing one account admit at most the cap', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const Database = (await import('better-sqlite3')).default
  const { migrateSpendPools } = await import('../lib/llm/spend-pool.ts'); const { sqliteDb } = await import('../lib/db/client.ts')
  const dir = mkdtempSync(join(tmpdir(), 'caps-r4-'))
  try {
    const h1 = new Database(join(dir, 'a.db')); h1.pragma('journal_mode = WAL'); h1.pragma('busy_timeout = 5000'); migrateSpendPools(h1)
    const h2 = new Database(join(dir, 'a.db')); h2.pragma('busy_timeout = 5000')
    const [d1, d2] = [sqliteDb(h1), sqliteDb(h2)]
    const out = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => runWithAccountSpend({ db: i % 2 ? d1 : d2, tenantId: A, limits: { day: 1, month: 10 }, clock: () => T0 }, () => reserveScanSpend('llm.anthropic', () => 0.3))))
    assert.equal(out.filter(o => o.status === 'fulfilled').length, 3)
    const [d] = await rows(d2, A)
    assert.ok((d[1] as number) <= 1 + 1e-9 && d[3] === 3, JSON.stringify(d))
    h1.close(); h2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// #846 review R3: a reservation and a settle of the same scan take their row locks in ONE order - the account's pool
// rows before the scan_jobs row - so a parallel settle and reservation can never deadlock on Postgres.
bothEngines('#846 review R3: reserve and settle both lock tenant_spend_pools before scan_jobs', async ({ db }) => {
  await job(db, 'j9', A)
  const order: string[][] = []
  const rec: Db = { ...db, kind: db.kind, all: db.all.bind(db), get: db.get.bind(db), run: db.run.bind(db), close: db.close.bind(db),
    tx: (body, iso) => db.tx(function* (t) {
      const seen: string[] = []; order.push(seen)
      const g = body(t); let r = g.next()
      while (!r.done) { const m = /^\s*(?:UPDATE|INSERT INTO|DELETE FROM)\s+(tenant_spend_pools|scan_jobs)\b/i.exec(r.value.sql); if (m && !seen.includes(m[1])) seen.push(m[1]); r = g.next(yield r.value) }
      return r.value
    }, iso) }
  const ctx = scanCtx(rec, 'j9', A, { accountLimits: { day: 5, month: 10 } })
  const h = await runWithScanSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.3))
  await h!.settle(0.1)
  assert.deepEqual(order, [['tenant_spend_pools', 'scan_jobs'], ['tenant_spend_pools', 'scan_jobs']], 'reserve, then settle: pool rows first in both')
})

// Review on #1154: the escape hatch out of the account caps is for tests and offline tools only. No module under lib/ or app/ may open it
// (spend-cap.ts, which defines it, excepted), so a product path can never run a model call uncapped.
test('#1154: runWithoutAccountSpend is used by no product module under lib/ or app/', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const f = `${d}/${n}`; return statSync(f).isDirectory() ? (n === 'node_modules' || n === '.next' ? [] : walk(f)) : /\.(ts|tsx|mts)$/.test(n) ? [f] : [] })
  const users = [...walk(`${root}lib`), ...walk(`${root}app`)].filter(f => !f.endsWith('/lib/scan/spend-cap.ts') && readFileSync(f, 'utf8').includes('runWithoutAccountSpend'))
  assert.deepEqual(users, [])
})

// XHawk on #1154: a reservation undone in the same transaction leaves no empty window rows behind; a settle whose window row is gone is an
// accounting failure (it throws, the transaction rolls back, the hold keeps its worst case), never a silent success.
bothEngines('#1154 XHawk: release removes the window rows it leaves empty; settle on a missing window row throws', async ({ db }) => {
  const { reservePoolWindows, releasePoolWindows, settlePoolWindows } = await import('../lib/llm/spend-pool.ts')
  const L = { day: 1, month: 10 }
  await db.tx(function* (t) { const ok = yield* reservePoolWindows(t, A, L, 0.3, T0); assert.equal(ok, true); yield* releasePoolWindows(t, A, L, 0.3, T0) })
  assert.deepEqual(await rows(db, A), [], 'a released reservation leaves the store as it found it')
  await db.tx(function* (t) { yield* reservePoolWindows(t, A, L, 0.3, T0) })
  assert.equal((await rows(db, A)).length, 2)
  await db.tx(function* (t) { yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE ?', [A, 'd%']) })
  await assert.rejects(db.tx(function* (t) { yield* settlePoolWindows(t, A, L, -0.1, 0.2, T0, T0 + 5) }), /spend_pool_window_missing/)
})

// #1154 XHawk (dcb00cc4): a settle that fails twice must not return as if it landed. Through the transport path (reserve -> call -> settle),
// the pool window row is deleted between reserve and settle: the failure is captured, the attempt makes no further paid request
// (accounting_uncertain), and the scan_spend_calls row stays 'reserved' at its worst case (what the reaper reads).
bothEngines('#1154 XHawk: a scan settle that fails twice is captured and stops the attempt (accounting_uncertain); the call row stays reserved', async ({ db }) => {
  const { setErrorSinks } = await import('../lib/ops/errors.ts')
  await job(db, 'j1', A)
  const ctx = scanCtx(db, 'j1', A, { accountLimits: { day: 5, month: 50 } })
  const h = await runWithScanSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.3))
  assert.ok(h)
  await db.tx(function* (t) { yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE ?', [A, 'd%']) })
  const seen: string[] = []
  const restore = setErrorSinks([r => { seen.push(r.where) }])
  try { await runWithScanSpend(ctx, () => h!.settle(0.1)) } finally { restore() }
  assert.deepEqual(seen, ['scan-spend-cap:settle'], 'the failure is captured')
  assert.deepEqual((await scanSpendCalls(db, 'j1', A)).map(c => [c.status, c.actual_usd]), [['reserved', null]], 'rolled back: the worst case stands, reserved for the reaper')
  assert.equal((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.3)
  await assert.rejects(runWithScanSpend(ctx, () => reserveScanSpend('render', () => 0.01)), refusedWith('accounting_uncertain'))
  await assert.rejects(runWithScanSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.01)), refusedWith('accounting_uncertain'))
  assert.equal((await scanSpendCalls(db, 'j1', A)).length, 1, 'no further reservation was written')
})

bothEngines('#1154 XHawk: an account-path settle that fails twice is captured and the context reserves nothing more (accounting_unsettled)', async ({ db }) => {
  const { setErrorSinks } = await import('../lib/ops/errors.ts')
  const ctx = { db, tenantId: A, limits: { day: 5, month: 50 }, clock: () => T0 }
  const h = await runWithAccountSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.3))
  assert.ok(h)
  await db.tx(function* (t) { yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE ?', [A, 'd%']) })
  const seen: string[] = []
  const restore = setErrorSinks([r => { seen.push(r.where) }])
  try { await runWithAccountSpend(ctx, () => h!.settle(0.1)) } finally { restore() }
  assert.deepEqual(seen, ['account-spend-cap:settle'])
  await assert.rejects(runWithAccountSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 0.01)), refusedWith('accounting_unsettled'))
})

// #1167 item 2: accountLimits is required on a scan context. A context opened without it (a cast, a JS caller, a future helper that
// forgets the field) used to run its model calls under the per-scan cap only, with no error. Now every model call in it is refused.
bothEngines('#1167 a scan context opened WITHOUT accountLimits refuses a model call (account_limits_missing); a non-model call is unaffected; null (the PooledGuard path) still reserves on the scan cap only', async ({ db }) => {
  await job(db, 'j1', A)
  const bare = { db, jobId: 'j1', tenantId: A, attempt: 1, cap: scanCapConfig({}), clock: () => T0 } as unknown as ScanSpendCtx
  await assert.rejects(runWithScanSpend(bare, () => reserveScanSpend('llm.anthropic', () => 0.01)), refusedWith('account_limits_missing'))
  const render = await runWithScanSpend(bare, () => reserveScanSpend('render', () => 0.01))
  assert.ok(render, 'a non-model kind never reached the account windows, so it is not refused for them')
  const pooled = await runWithScanSpend(scanCtx(db, 'j1', A, { accountLimits: null }), () => reserveScanSpend('llm.anthropic', () => 0.01))
  assert.ok(pooled); assert.deepEqual(await rows(db, A), [], 'null: the runner\'s PooledGuard counts the account, the transport writes no window')
})
