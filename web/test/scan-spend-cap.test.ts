// The hard per-scan spend cap (lib/scan/spend-cap.ts, #377 / #533 closure blocker 1). Synthetic rows and stubs only:
// no provider is called. The ledger cases run on both engines (SQLite in memory; Postgres when DAZL_TEST_PG_URL is set).
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import {
  DEFAULT_UNIT_USD, HARD_CAP_USD, modelCostUsd, reserveScanSpend, runWithJobSpend, runWithScanSpend, scanCapConfig, scanModelPrice,
  scanSpendCalls, scanSpendRow, servedCostUsd, unitCostUsd, type ScanSpendCtx,
} from '../lib/scan/spend-cap.ts'
import { bothEngines } from './helpers/engines.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const T0 = 1_800_000_000
const OK_CAP = scanCapConfig({})
async function job(db: Db, id: string, tenant: string, o: { attempts?: number; status?: string; runBudget?: string | null } = {}) {
  await db.run('INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts, run_budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, tenant, 'Biz', 'software', 'Toronto', o.status ?? 'running', o.attempts ?? 1, o.runBudget ?? null])
}
const ctx = (db: Db, jobId: string, tenantId: string, o: Partial<ScanSpendCtx> = {}): ScanSpendCtx => ({ db, jobId, tenantId, attempt: 1, cap: OK_CAP, accountLimits: null, clock: () => T0, ...o })
const refusedWith = (reason: string) => (e: unknown) => e instanceof SpendRefused && e.reason === reason
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

test('cap setting: CAD 5 default and hard ceiling, FX floor 1.50; malformed values refuse, never fall back', () => {
  assert.deepEqual(scanCapConfig({}), { ok: true, capCad: 5, fxCadPerUsd: 1.5, capUsd: 5 / 1.5 })
  assert.ok(near(HARD_CAP_USD, 5 / 1.5))
  const cap = (env: Record<string, string | undefined>) => { const c = scanCapConfig(env); return c.ok ? c.capUsd : c.reason }
  assert.ok(near(cap({ DAZL_SCAN_CAP_CAD: '50' }) as number, 5 / 1.5), 'a higher cap is clamped to CAD 5')
  assert.ok(near(cap({ DAZL_SCAN_CAP_CAD: '3' }) as number, 2), 'a lower cap lowers it')
  assert.ok(near(cap({ DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.1' }) as number, 5 / 1.5), 'a lower FX rate is clamped up to the 1.50 floor')
  assert.ok(near(cap({ DAZL_SCAN_CAP_FX_CAD_PER_USD: '2' }) as number, 2.5), 'a higher FX rate only lowers the USD cap')
  for (const bad of ['0', '-1', 'abc', '1e3', ' 5', '5 ', '5.0.0', '0x5', '+5', 'Infinity', 'NaN', '5,0', '٥', '1234567', '1.1234567891']) {
    assert.equal(cap({ DAZL_SCAN_CAP_CAD: bad }), 'cap_config_invalid', `cap ${JSON.stringify(bad)}`)
    assert.equal(cap({ DAZL_SCAN_CAP_FX_CAD_PER_USD: bad }), 'cap_config_invalid', `fx ${JSON.stringify(bad)}`)
  }
  // non-string values (a mis-typed env object) are malformed too
  assert.equal(cap({ DAZL_SCAN_CAP_CAD: 5 as unknown as string }), 'cap_config_invalid')
})

test('unit prices: documented defaults, env overrides, malformed settings and TinyFish free allowance', () => {
  assert.deepEqual(DEFAULT_UNIT_USD, { 'apollo.org': 0.2, 'apollo.people': 0.2, 'pdl.people': 0.28, render: 0.01 })
  assert.ok(near(unitCostUsd('apollo.org', 1, {}), 0.2))
  assert.ok(near(unitCostUsd('apollo.people', 1, {}), 0.2))
  assert.ok(near(unitCostUsd('pdl.people', 5, {}), 1.4))
  assert.ok(near(unitCostUsd('render', 1, {}), 0.01))
  assert.equal(unitCostUsd('render', 1, { DAZL_SCAN_PRICE_RENDER_USD: '0' }), 0, 'a self-hosted renderer can be priced 0')
  assert.ok(near(unitCostUsd('apollo.org', 1, { DAZL_SCAN_PRICE_APOLLO_ORG_USD: '0.5' }), 0.5))
  for (const bad of ['-1', 'abc', '1e-3', ' 0.2', '0x1', 'NaN']) {
    assert.throws(() => unitCostUsd('apollo.org', 1, { DAZL_SCAN_PRICE_APOLLO_ORG_USD: bad }), refusedWith('price_invalid'), bad)
    assert.throws(() => unitCostUsd('tinyfish.search', 1, { DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD: bad }), refusedWith('price_invalid'), bad)
  }
  for (const units of [0, -1, 1.5, 1001, NaN, '2' as unknown as number]) assert.throws(() => unitCostUsd('pdl.people', units, {}), refusedWith('units_invalid'), String(units))
  // TinyFish: free only while dazl's own global daily caps stay inside the documented free allowance
  assert.equal(unitCostUsd('tinyfish.search', 1, {}), 0)
  assert.equal(unitCostUsd('tinyfish.fetch', 16, {}), 0)
  assert.equal(unitCostUsd('tinyfish.search', 1, { TINYFISH_GLOBAL_SEARCH_DAILY: '12000' }), 0)
  assert.throws(() => unitCostUsd('tinyfish.search', 1, { TINYFISH_GLOBAL_SEARCH_DAILY: '12001' }), refusedWith('price_unknown'))
  assert.throws(() => unitCostUsd('tinyfish.fetch', 1, { TINYFISH_GLOBAL_FETCH_DAILY: '1001' }), refusedWith('price_unknown'))
  assert.ok(near(unitCostUsd('tinyfish.fetch', 4, { TINYFISH_GLOBAL_FETCH_DAILY: '5000', DAZL_SCAN_PRICE_TINYFISH_FETCH_USD: '0.01' }), 0.04), 'a stated price covers a cap above the allowance')
  assert.ok(near(unitCostUsd('tinyfish.search', 1, { TINYFISH_GLOBAL_SEARCH_DAILY: '50000', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.002' }), 0.002), "the trial's price is the fallback")
})

test('model prices: every model the scan path requests by default is listed; an unlisted model is refused', () => {
  assert.deepEqual(scanModelPrice('claude-sonnet-4-5'), { in: 3, out: 15 })
  assert.deepEqual(scanModelPrice('claude-sonnet-4-5-20250929'), { in: 3, out: 15 })
  assert.deepEqual(scanModelPrice('gpt-4.1'), { in: 3.5, out: 14 })
  assert.deepEqual(scanModelPrice('gpt-4.1-2025-04-14'), { in: 3.5, out: 14 })
  for (const m of ['gpt-4.1-mini', 'claude-unlisted', '', null, undefined, 'constructor', '__proto__', 'toString']) assert.equal(scanModelPrice(m as string), null, String(m))
  const prompt = 'x'.repeat(4000)
  assert.ok(near(modelCostUsd('claude-sonnet-4-5', prompt, 1000), ((4000 + 1000) * 3 + 1000 * 15) / 1e6))
  assert.ok(near(modelCostUsd('gpt-4.1', prompt, 1000), ((4000 + 1000) * 3.5 + 1000 * 14) / 1e6))
  assert.ok(near(modelCostUsd('claude-sonnet-4-5', 'é', 1), ((2 + 1000) * 3 + 15) / 1e6), 'input is UTF-8 bytes, not characters')
  assert.throws(() => modelCostUsd('claude-unlisted', prompt, 10), refusedWith('model_unpriced'))
  assert.throws(() => modelCostUsd(undefined, prompt, 10), refusedWith('model_unpriced'))
  for (const max of [0, -1, 1.5, 200_001, NaN]) assert.throws(() => modelCostUsd('gpt-4.1', prompt, max), refusedWith('cost_invalid'), String(max))
  assert.throws(() => modelCostUsd('gpt-4.1', null as unknown as string, 10), refusedWith('cost_invalid'))
  // settle: the served model's price on what the vendor reported, or null (the worst case stands)
  assert.ok(near(servedCostUsd('claude-sonnet-4-5-20250929', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 })!, (100 * 3 + 10 * 15 + 20 * 3 * 2 + 50 * 3 * 0.1) / 1e6))
  for (const [m, u] of [['gpt-4.1', undefined], [null, { input_tokens: 1, output_tokens: 1 }], ['claude-unlisted', { input_tokens: 1, output_tokens: 1 }], ['gpt-4.1', { input_tokens: 1 }], ['gpt-4.1', { input_tokens: -1, output_tokens: 1 }], ['gpt-4.1', { input_tokens: '1', output_tokens: 1 }], ['gpt-4.1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: NaN }]] as const) {
    assert.equal(servedCostUsd(m, u as never), null, JSON.stringify([m, u]))
  }
})

test('outside a scan there is no gate: reserveScanSpend returns null and records nothing', async () => {
  assert.equal(await reserveScanSpend('apollo.org', () => { throw new Error('never priced') }), null)
})

bothEngines('scan spend cap: a reservation is durable before the call, settles once, and a replayed settle changes nothing', async ({ db }) => {
  await job(db, 'j1', A)
  const hold = await runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('apollo.org', () => 0.2))
  assert.ok(hold)
  // durable BEFORE the call: the row and the job's ledger already carry the worst case
  assert.deepEqual((await scanSpendCalls(db, 'j1', A)).map(c => [c.kind, c.status, c.reserve_usd, c.attempt]), [['apollo.org', 'reserved', 0.2, 1]])
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.2))
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_usd!, 5 / 1.5), 'the cap the scan runs under is on its row')
  await hold!.settle(0.05)
  await hold!.settle(0) // replay: no effect
  const c = (await scanSpendCalls(db, 'j1', A))[0]
  assert.deepEqual([c.status, c.actual_usd], ['settled', 0.05])
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.05))
  // a failed call keeps its full worst case
  const h2 = await runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('render', () => 0.01))
  await h2!.settle(null)
  await h2!.settle(0.001) // replay after kept: no effect
  assert.deepEqual((await scanSpendCalls(db, 'j1', A)).map(c => c.status).sort(), ['kept', 'settled'])
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.06))
  // malformed settle amounts keep the worst case
  for (const bad of [NaN, -1, Infinity, '0.1' as unknown as number]) {
    const h = await runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('render', () => 0.01))
    await h!.settle(bad)
  }
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 0.1))
  assert.equal((await scanSpendCalls(db, 'j1', A)).filter(c => c.status === 'kept').length, 5)
})

bothEngines('scan spend cap: concurrent reservations on one scan can never pass the cap together', async ({ db }) => {
  await job(db, 'j1', A)
  const results = await runWithScanSpend(ctx(db, 'j1', A), () => Promise.allSettled(Array.from({ length: 20 }, () => reserveScanSpend('apollo.org', () => 0.3))))
  const ok = results.filter(r => r.status === 'fulfilled').length
  assert.equal(ok, 11, '11 x 0.30 = 3.30 fits under USD 3.3333; a 12th does not')
  assert.ok(results.filter(r => r.status === 'rejected').every(r => refusedWith('over_cap')((r as PromiseRejectedResult).reason)))
  const row = (await scanSpendRow(db, 'j1', A))!
  assert.ok(row.spend_cap_reserved_usd <= HARD_CAP_USD + 1e-9)
  assert.ok(near(row.spend_cap_reserved_usd, 3.3))
  assert.equal(row.spend_cap_refusals, 9)
  const calls = await scanSpendCalls(db, 'j1', A)
  assert.deepEqual([calls.filter(c => c.status === 'reserved').length, calls.filter(c => c.status === 'refused' && c.reason === 'over_cap').length], [11, 9])
}, { pgMax: 8 })

bothEngines('scan spend cap: a crash between reserve and settle keeps the worst case; a lost attempt and another tenant are refused and recorded', async ({ db }) => {
  await job(db, 'j1', A)
  await job(db, 'jb', B)
  // crash: attempt 1 reserves 2.0 and never settles; the reaper re-claims the job as attempt 2
  assert.ok(await runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('pdl.people', () => 2)))
  await db.run('UPDATE scan_jobs SET attempts = 2 WHERE id = ?', ['j1'])
  // attempt 2 draws on the same ledger: 2.0 is still counted, so 1.5 more does not fit
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A, { attempt: 2 }), () => reserveScanSpend('pdl.people', () => 1.5)), refusedWith('over_cap'))
  assert.ok(await runWithScanSpend(ctx(db, 'j1', A, { attempt: 2 }), () => reserveScanSpend('apollo.org', () => 1)))
  // the lost attempt 1 can no longer reserve anything
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('ownership_lost'))
  // a malformed attempt (NaN, a string) is never a match
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A, { attempt: NaN }), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('ownership_lost'))
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A, { attempt: '2' as unknown as number }), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('ownership_lost'))
  // tenant B naming A's job id: refused, recorded under B, A's ledger untouched
  const before = await scanSpendRow(db, 'j1', A)
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', B, { attempt: 2 }), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('scan_not_found'))
  assert.deepEqual(await scanSpendRow(db, 'j1', A), before)
  assert.deepEqual((await scanSpendCalls(db, 'j1', B)).map(c => [c.status, c.reason]), [['refused', 'scan_not_found']])
  assert.equal((await scanSpendCalls(db, 'j1', A)).filter(c => c.reason === 'scan_not_found').length, 0, "B's refusal is never one of A's rows")
  // an unknown job id, and a finished-and-failed (cancelled) job
  await assert.rejects(runWithScanSpend(ctx(db, 'nope', A), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('scan_not_found'))
  await db.run("UPDATE scan_jobs SET status = 'failed' WHERE id = ?", ['jb'])
  await assert.rejects(runWithScanSpend(ctx(db, 'jb', B), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('scan_not_active'))
  const a = await scanSpendCalls(db, 'j1', A)
  assert.deepEqual(a.map(c => [c.attempt, c.status, c.reason]).sort(), [[-1, 'refused', 'ownership_lost'], [-1, 'refused', 'ownership_lost'], [1, 'refused', 'ownership_lost'], [1, 'reserved', null], [2, 'refused', 'over_cap'], [2, 'reserved', null]].sort())
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_reserved_usd, 3))
})

bothEngines('scan spend cap: malformed cap, price, cost and kind refuse before any call, and the refusal is recorded', async ({ db }) => {
  await job(db, 'j1', A)
  const bad = scanCapConfig({ DAZL_SCAN_CAP_CAD: 'five' })
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A, { cap: bad }), () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('cap_config_invalid'))
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('apollo.org', () => unitCostUsd('apollo.org', 1, { DAZL_SCAN_PRICE_APOLLO_ORG_USD: '-1' }))), refusedWith('price_invalid'))
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('llm.anthropic', () => modelCostUsd('claude-unlisted', 'p', 10))), refusedWith('model_unpriced'))
  for (const cost of [NaN, -0.5, Infinity, '0.1' as unknown as number, null as unknown as number]) {
    await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('render', () => cost)), refusedWith('cost_invalid'), String(cost))
  }
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('render', () => { throw new TypeError('boom') })), refusedWith('cost_invalid'))
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('stripe.charge' as never, () => 0)), refusedWith('kind_unknown'))
  // one huge reservation alone
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('pdl.people', () => 1e9)), refusedWith('over_cap'))
  const calls = await scanSpendCalls(db, 'j1', A)
  assert.ok(calls.every(c => c.status === 'refused'))
  assert.deepEqual(calls.map(c => c.reason).sort(), ['cap_config_invalid', 'cost_invalid', 'cost_invalid', 'cost_invalid', 'cost_invalid', 'cost_invalid', 'cost_invalid', 'kind_unknown', 'model_unpriced', 'over_cap', 'price_invalid'])
  const row = (await scanSpendRow(db, 'j1', A))!
  assert.deepEqual([row.spend_cap_reserved_usd, row.spend_cap_refusals], [0, 11])
})

bothEngines("scan spend cap: the request's max_usd and a lower setting only lower the cap; a later, higher setting never raises it", async ({ db }) => {
  await job(db, 'j1', A)
  await assert.rejects(runWithScanSpend(ctx(db, 'j1', A, { requestMaxUsd: 0.5 }), () => reserveScanSpend('apollo.org', () => 0.6)), refusedWith('over_cap'))
  assert.ok(await runWithScanSpend(ctx(db, 'j1', A, { requestMaxUsd: 0.5 }), () => reserveScanSpend('apollo.org', () => 0.4)))
  assert.ok(near((await scanSpendRow(db, 'j1', A))!.spend_cap_usd!, 0.5))
  // a later attempt with no request budget (or a malformed one) still runs under the stored 0.5
  for (const req of [null, 100, -1, NaN, '9' as unknown as number]) {
    await assert.rejects(runWithScanSpend(ctx(db, 'j1', A, { requestMaxUsd: req }), () => reserveScanSpend('apollo.org', () => 0.2)), refusedWith('over_cap'), String(req))
  }
  await job(db, 'j2', A)
  const low = scanCapConfig({ DAZL_SCAN_CAP_CAD: '1.5' }) // USD 1
  assert.ok(await runWithScanSpend(ctx(db, 'j2', A, { cap: low }), () => reserveScanSpend('apollo.org', () => 0.9)))
  await assert.rejects(runWithScanSpend(ctx(db, 'j2', A), () => reserveScanSpend('apollo.org', () => 0.2)), refusedWith('over_cap'), 'the default setting does not raise the stored USD 1')
  // the store itself refuses a cap above the hard ceiling
  await assert.rejects(db.run('UPDATE scan_jobs SET spend_cap_usd = 4 WHERE id = ?', ['j2']))
  await assert.rejects(db.run('UPDATE scan_jobs SET spend_cap_reserved_usd = -1 WHERE id = ?', ['j2']))
})

bothEngines('scan spend cap: the owner retry of a held lookup draws on its own scan, never another tenant\'s', async ({ db }) => {
  await job(db, 'j1', A, { status: 'done', attempts: 3, runBudget: '{"max_usd":0.3}' })
  assert.ok(await runWithJobSpend(db, A, 'j1', () => reserveScanSpend('apollo.org', () => 0.2)))
  await assert.rejects(runWithJobSpend(db, A, 'j1', () => reserveScanSpend('apollo.org', () => 0.2)), refusedWith('over_cap'), "the scan's own max_usd applies")
  await assert.rejects(runWithJobSpend(db, B, 'j1', () => reserveScanSpend('apollo.org', () => 0.01)), refusedWith('scan_not_found'))
  for (const rb of ['not json', '[]', 'null', '{"max_usd":"5"}']) {
    await job(db, `jr${rb.length}`, A, { status: 'done', runBudget: rb })
    assert.ok(await runWithJobSpend(db, A, `jr${rb.length}`, () => reserveScanSpend('apollo.org', () => 3)), rb)
  }
  assert.deepEqual((await scanSpendCalls(db, 'j1', A)).map(c => `${c.attempt}:${c.status}`).sort(), ['3:refused', '3:reserved'])
})

test('scan spend cap: a store that does not answer refuses the call (ledger_unavailable) and logs it', async () => {
  const broken = { kind: 'sqlite', tx: async () => { throw new Error('disk I/O error') }, get: async () => undefined, all: async () => [], run: async () => ({ changes: 0 }), close: async () => {} } as unknown as Db
  const errs: unknown[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errs.push(a) }
  try {
    await assert.rejects(runWithScanSpend(ctx(broken, 'j1', A), () => reserveScanSpend('apollo.org', () => 0.2)), refusedWith('ledger_unavailable'))
  } finally { console.error = orig }
  // a settle that cannot be saved never throws (the worst case stands)
  let n = 0
  const flaky = { kind: 'sqlite', tx: async () => { if (n++ === 0) return null; throw new Error('gone') }, get: async () => undefined, all: async () => [], run: async () => ({ changes: 0 }), close: async () => {} } as unknown as Db
  console.error = () => {}
  try {
    const h = await runWithScanSpend(ctx(flaky, 'j1', A), () => reserveScanSpend('apollo.org', () => 0.2))
    await h!.settle(0.1)
  } finally { console.error = orig }
  assert.equal(n, 3, 'reserve, then the settle and its one retry')
})

bothEngines('scan spend cap: a settle refreshes the lease ONLY for its own attempt and only on a real transition', async ({ db }) => {
  await job(db, 'j1', A)
  const h = await runWithScanSpend(ctx(db, 'j1', A), () => reserveScanSpend('apollo.org', () => 0.2))
  // A newer attempt owns the job before the old hold settles: the old call's accounting still closes (settled), but its
  // settle must NOT refresh the newer attempt's lease (attempts fence).
  await db.run("UPDATE scan_jobs SET attempts = 2, claimed_at = 1 WHERE id = 'j1' AND user_id = ?", [A])
  await h!.settle(0.1)
  const j1 = await db.get<{ claimed_at: number | string }>("SELECT claimed_at FROM scan_jobs WHERE id = 'j1' AND user_id = ?", [A])
  assert.equal(Number(j1!.claimed_at), 1, "an old hold's settle never refreshes a newer attempt's lease")
  const calls = await scanSpendCalls(db, 'j1', A)
  assert.equal(calls[0].status, 'settled', "the old call's accounting still closes")

  await job(db, 'j2', A)
  const h2 = await runWithScanSpend(ctx(db, 'j2', A), () => reserveScanSpend('apollo.org', () => 0.2))
  await db.run("UPDATE scan_jobs SET claimed_at = 1 WHERE id = 'j2' AND user_id = ?", [A])
  await h2!.settle(0.1)
  const j2 = await db.get<{ claimed_at: number | string }>("SELECT claimed_at FROM scan_jobs WHERE id = 'j2' AND user_id = ?", [A])
  assert.ok(Number(j2!.claimed_at) > 100000, 'a same-attempt real settle DOES refresh the lease (DB clock, not the app clock)')

  // The REPLAY branch: the old hold's settle is delivered AGAIN after a newer attempt owns the job. The row is already
  // 'settled', so the replay is a no-transition no-op (r.changes === 0): it must NOT refresh the newer attempt's lease
  // and must NOT re-apply the cost delta to the reserved total (a double-counted delta corrupts the cap).
  await job(db, 'j3', A)
  const h3 = await runWithScanSpend(ctx(db, 'j3', A), () => reserveScanSpend('apollo.org', () => 0.2))
  await h3!.settle(0.1) // the real first settle: transition applied, delta -0.1 applied to the reserved total
  const before = await db.get<{ spend_cap_reserved_usd: number | string }>("SELECT spend_cap_reserved_usd FROM scan_jobs WHERE id = 'j3' AND user_id = ?", [A])
  await db.run("UPDATE scan_jobs SET attempts = 2, claimed_at = 1 WHERE id = 'j3' AND user_id = ?", [A]) // a newer attempt owns the job
  await h3!.settle(0.1) // REPLAY: already-settled row, no transition
  const j3 = await db.get<{ claimed_at: number | string; spend_cap_reserved_usd: number | string }>("SELECT claimed_at, spend_cap_reserved_usd FROM scan_jobs WHERE id = 'j3' AND user_id = ?", [A])
  assert.equal(Number(j3!.claimed_at), 1, 'a replayed settle never refreshes the newer attempt')
  assert.equal(Number(j3!.spend_cap_reserved_usd), Number(before!.spend_cap_reserved_usd), 'a replayed settle never re-applies the cost delta')
})

// #1006 (reviewer repro 03:29): a saved run budget below the fixed cap refuses as over_cap - and the outcome copy must
// therefore name NEITHER the fixed cap NOR a run budget: the recorded cap's binding origin is not retained.
bothEngines('scan spend cap: a saved run budget refusal is over_cap, and the outcome copy names no origin and advises no budget change', async ({ db }) => {
  await job(db, 'jcap', A, { status: 'running', attempts: 1, runBudget: '{"max_usd":0.01}' })
  await assert.rejects(runWithJobSpend(db, A, 'jcap', () => reserveScanSpend('apollo.org', () => 0.02)), refusedWith('over_cap'))
  const { scanOutcome } = await import('../lib/scan/scan-outcome.ts')
  const o = scanOutcome({ id: 'jcap'.padEnd(24, '0'), status: 'failed', error: 'budget_stopped', candidates: 0, verified: 0, needs_review: 0, dropped: 0, lead_count: 0, stop_refusal_reason: 'over_cap' })
  assert.equal(o.label, 'Stopped by its spending cap - not an empty search')
  assert.doesNotMatch(`${o.detail} ${o.next?.text}`, /fixed|larger budget|narrower/i)
})
