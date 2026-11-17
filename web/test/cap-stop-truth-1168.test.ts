// #1168: a scan stopped by the account spending limit tells the truth. Built from the two real runs taken for #1154 on a production
// build of that branch (2026-11-13, a brand-new free-trial account, DAZL_OWNER_DAY_MAX_USD=0.01, request "Austin B2B SaaS companies
// hiring their first account executive in the last 30 days"):
//   job 434086302058d86a308d9b96: three model calls refused owner_pool_limit before sending (reserve 0.019407, 0.011652, 0.059082),
//     search and fetch settled at 0; the page said "3 model calls recorded, but the provider reported no token usage for them, so the
//     actual cost is unknown - not $0", and scan_jobs.spend_reserved_usd kept 0.090141 (charged to the trial wallet when it settled).
//   job b51c4104e46070941c974229: two model calls refused owner_pool_limit, then the search failed; the page said "A source this run
//     depends on failed ... This was not a budget stop".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compareActual } from '../lib/scan/price-estimate.ts'
import { meterProvider, type ModelCall } from '../lib/scan/model-usage.ts'
import { guardProvider, SpendGuard, SpendRefused } from '../lib/llm/spend-guard.ts'
import { earlierLimitRefusal } from '../lib/scan/runner.ts'
import { migrateScanSpendCap } from '../lib/scan/spend-cap.ts'
import { migrateScan } from '../lib/scan/store.ts'
import type { Provider } from '../lib/llm/provider.ts'

// the real ledger rows of the two jobs (kind, reserve_usd, status, reason), in order
const JOB_REFUSED = [['llm.anthropic', 0.019407, 'refused', 'owner_pool_limit'], ['llm.anthropic', 0.011652, 'refused', 'owner_pool_limit'], ['tinyfish.search', 0, 'settled', null], ['tinyfish.fetch', 0, 'settled', null], ['llm.anthropic', 0.059082, 'refused', 'owner_pool_limit']] as const
const JOB_SOURCE_FAILED = [['llm.anthropic', 0.019407, 'refused', 'owner_pool_limit'], ['llm.anthropic', 0.011652, 'refused', 'owner_pool_limit'], ['tinyfish.search', 0, 'settled', null]] as const
// the model rows of the estimate the user confirmed ($0.09 - $0.66)
const EST = { total: { min: 0.093, max: 0.6615 }, rows: [{ id: 'm', kind: 'model', label: 'model', usd: { min: 0.09, max: 0.66 } }] } as unknown as Parameters<typeof compareActual>[0]

test('#1168 item 1: three model calls refused before sending -> the cost line says no model call was made and the cost is $0, never "recorded ... unknown"', () => {
  const refused = JOB_REFUSED.filter(r => r[0].startsWith('llm.') && r[2] === 'refused').length
  const a = compareActual(EST, { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 1, reservedUsd: 0, requests: 0, requestsWithTokens: 0, refusedBeforeSending: refused })
  assert.equal(a.summary, 'No model call was made: 3 were refused by a spending limit before sending, so the model cost is $0. Estimate was $0.09-$0.66.')
  assert.doesNotMatch(a.summary, /recorded|unknown/)
  // one refused call reads in the singular; calls that WERE sent keep the existing wording (the refusals do not hide them)
  assert.match(compareActual(EST, { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0, refusedBeforeSending: 1 }).summary, /^No model call was made: 1 was refused/)
  assert.match(compareActual(EST, { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 2, requestsWithTokens: 0, refusedBeforeSending: 1 }).summary, /^2 model calls recorded/)
  assert.match(compareActual(EST, { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0 }).summary, /^Actual model cost was not recorded/)
})

test('#1168 item 1: a call refused before sending is not recorded as a model request; a call that failed after it was sent still is', async () => {
  const calls: ModelCall[] = []
  const refusing = { completeDetailed: async () => { throw new SpendRefused('owner_pool_limit') }, research: async () => { throw new SpendRefused('owner_pool_limit') } } as unknown as Provider
  const m = meterProvider(refusing, c => calls.push(c))
  await assert.rejects(m.completeDetailed!('k', 'p', undefined, 10), SpendRefused)
  await assert.rejects(m.complete!('k', 'p', undefined, 10), SpendRefused)
  await assert.rejects(m.research('k', 'p'), SpendRefused)
  assert.equal(calls.length, 0, 'nothing was sent, so nothing is recorded')
  const failing = { completeDetailed: async () => { throw new Error('socket hang up') }, research: async () => { throw new Error('x') } } as unknown as Provider
  const sent: ModelCall[] = []
  await assert.rejects(meterProvider(failing, c => sent.push(c)).completeDetailed!('k', 'p', undefined, 10))
  assert.deepEqual(sent.map(c => c.outcome), ['error'], 'a request that may have reached the provider is recorded')
})

test('#1168 item 3: the scan\'s own guard gives back the reservation of a call the cap refused before sending (0.090141 was kept and charged to the trial)', async () => {
  for (const settle of [false, true]) {
    const saved: number[] = []
    const g = new SpendGuard(3); g.persist = usd => { saved.push(usd) }
    const capRefuses = { configuredModel: () => 'claude-sonnet-4-5', completeDetailed: async () => { throw new SpendRefused('owner_pool_limit') }, research: async () => { throw new SpendRefused('research_unbounded') } } as unknown as Provider
    const p = guardProvider(capRefuses, g, undefined, undefined, settle)
    for (let i = 0; i < 3; i++) await assert.rejects(p.completeDetailed!('k', 'a prompt', undefined, 300), (e: unknown) => e instanceof SpendRefused && e.reason === 'owner_pool_limit')
    assert.equal(g.reservedUsd, 0, `settle=${settle}: nothing stays reserved for calls never sent`)
    assert.equal(saved.at(-1), 0, 'and the job row (spend_reserved_usd) is written back to 0')
    // a call that failed AFTER sending keeps its reservation: the vendor may have billed it
    const sentThenFailed = { configuredModel: () => 'claude-sonnet-4-5', completeDetailed: async () => { throw new Error('socket hang up') }, research: async () => { throw new Error('x') } } as unknown as Provider
    await assert.rejects(guardProvider(sentThenFailed, g, undefined, undefined, settle).completeDetailed!('k', 'a prompt', undefined, 300))
    assert.ok(g.reservedUsd > 0, `settle=${settle}: a sent call keeps its worst case`)
  }
})

test('#1168 item 2: the ledger names the limit that refused first; a later source failure does not hide it (job b51c4104)', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateScanSpendCap(db)
  const seed = (job: string, rows: readonly (readonly [string, number, string, string | null])[], attempt = 1) => rows.forEach((r, i) => db.prepare('INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)').run(`${job}-${attempt}-${i}`, 'u', job, attempt, r[0], r[1], r[2], r[3], 1794602998))
  seed('b51c4104e46070941c974229', JOB_SOURCE_FAILED); seed('434086302058d86a308d9b96', JOB_REFUSED)
  assert.equal(earlierLimitRefusal(db, { id: 'b51c4104e46070941c974229', attempts: 1, user_id: 'u' }), 'owner_pool_limit')
  assert.equal(earlierLimitRefusal(db, { id: '434086302058d86a308d9b96', attempts: 1, user_id: 'u' }), 'owner_pool_limit')
  // only a NUMERIC limit counts (a config or accounting refusal refuses at any budget), only this attempt, only a refused row
  seed('other', [['llm.anthropic', 0.01, 'refused', 'cap_config_invalid'], ['llm.anthropic', 0.01, 'settled', null]])
  assert.equal(earlierLimitRefusal(db, { id: 'other', attempts: 1, user_id: 'u' }), null)
  assert.equal(earlierLimitRefusal(db, { id: 'b51c4104e46070941c974229', attempts: 2, user_id: 'u' }), null, 'an earlier attempt\'s refusal is not this attempt\'s')
  // only a MODEL call: a render or TinyFish call refused by the per-scan cap does not relabel a genuine source failure (independent review)
  seed('render-only', [['render', 0.01, 'refused', 'over_cap'], ['tinyfish.search', 0, 'refused', 'over_cap']])
  assert.equal(earlierLimitRefusal(db, { id: 'render-only', attempts: 1, user_id: 'u' }), null)
  // the ACCOUNT limit refusing any paid step is the limit stop (at the cap the account sends nothing): a refused search counts
  seed('acct-search', [['tinyfish.search', 0, 'refused', 'owner_pool_limit']])
  assert.equal(earlierLimitRefusal(db, { id: 'acct-search', attempts: 1, user_id: 'u' }), 'owner_pool_limit')
  // review at b8eef37e: the job's own tenant only, through the (user_id, scan_job_id) index - never a scan of the whole table
  assert.equal(earlierLimitRefusal(db, { id: 'b51c4104e46070941c974229', attempts: 1, user_id: 'someone-else' }), null)
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT reason FROM scan_spend_calls WHERE user_id = ? AND scan_job_id = ? AND attempt = ? AND status = 'refused' AND (reason = ? OR (kind LIKE 'llm.%' AND reason IN (?, ?))) ORDER BY created_at, rowid LIMIT 1").all('u', 'j', 1, 'x', 'y', 'z') as { detail: string }[]
  assert.ok(plan.some(r => /SEARCH scan_spend_calls USING INDEX/.test(r.detail)) && !plan.some(r => /^SCAN scan_spend_calls/.test(r.detail)), JSON.stringify(plan))
})

test('#1168 review: a failed ledger read is recorded, never a silent return to the old stop name', async () => {
  const { setErrorSinks } = await import('../lib/ops/errors.ts')
  const db = new Database(':memory:')   // no scan_spend_calls table: the read throws
  const seen: string[] = []; const restore = setErrorSinks([r => { seen.push(r.where) }])
  try { assert.equal(earlierLimitRefusal(db, { id: 'j', attempts: 1, user_id: 'a'.repeat(32) }), null) } finally { restore() }
  assert.equal(seen.length, 1, JSON.stringify(seen))
})

test('#1168 review: a release of an unsent call that cannot be saved is retried once, then recorded; the reservation stays (over-count only)', async () => {
  const { setErrorSinks } = await import('../lib/ops/errors.ts')
  let writes = 0
  const g = new SpendGuard(3); g.persist = () => { writes++; if (writes > 1) throw new Error('store down') }   // the reserve saves, every release fails
  const capRefuses = { configuredModel: () => 'claude-sonnet-4-5', completeDetailed: async () => { throw new SpendRefused('owner_pool_limit') }, research: async () => { throw new SpendRefused('research_unbounded') } } as unknown as Provider
  const seen: string[] = []; const restore = setErrorSinks([r => { seen.push(r.where) }])
  try { await assert.rejects(guardProvider(capRefuses, g).completeDetailed!('k', 'a prompt', undefined, 300), SpendRefused) } finally { restore() }
  assert.equal(writes, 3, 'one reserve, then the release tried twice')
  assert.equal(seen.length, 1, 'the failed release is recorded once')
  assert.ok(g.reservedUsd > 0, 'the reservation stays: the count errs high')
})

test('#1168 item 1: the count behind the cost line is this tenant\'s model calls refused by a numeric limit, nothing else', async () => {
  const { readRefusedModelCalls } = await import('../lib/scan/status-reads.ts'); const { sqliteDb } = await import('../lib/db/client.ts')
  const raw = new Database(':memory:'); migrateScan(raw); migrateScanSpendCap(raw)
  const ins = raw.prepare('INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, 1, ?, 0.01, NULL, ?, ?, 1, NULL)')
  JOB_REFUSED.forEach((r, i) => ins.run(`a${i}`, 'u', 'j', r[0], r[2], r[3]))
  ins.run('cfg', 'u', 'j', 'llm.anthropic', 'refused', 'cap_config_invalid'); ins.run('own', 'u', 'j', 'llm.anthropic', 'refused', 'ownership_lost')
  ins.run('rnd', 'u', 'j', 'render', 'refused', 'over_cap'); ins.run('oth', 'other-tenant', 'j', 'llm.anthropic', 'refused', 'owner_pool_limit')
  const db = sqliteDb(raw)
  assert.equal(await readRefusedModelCalls(db, 'u', 'j'), 3, 'the three owner_pool_limit model refusals of job 434086302058d86a308d9b96')
  assert.equal(await readRefusedModelCalls(db, 'other-tenant', 'j'), 1)
  assert.equal(await readRefusedModelCalls(db, 'u', 'none'), 0)
  // review at b8eef37e (cap hit between call 1 and 2, DAZL_MODEL_USAGE=0): a model call that LEFT (a kept / settled / reserved ledger
  // row) means the line must not claim "no model call was made", whatever scan_model_calls holds
  ins.run('kept', 'u', 'j', 'llm.anthropic', 'kept', null)
  assert.equal(await readRefusedModelCalls(db, 'u', 'j'), null)
  assert.match(compareActual(EST, { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0, refusedBeforeSending: await readRefusedModelCalls(db, 'u', 'j') }).summary, /^Actual model cost was not recorded/)
})

// The real run for this PR found the production build broken at 0f6a7c1d: lib/llm/spend-guard.ts is bundled for the browser (the
// estimate panel prices with it: app/app/leads/estimate-confirm.tsx -> price-estimate.ts -> spend-guard.ts), and it had gained an
// import of the server's error recorder (lib/ops/errors.ts -> emitted.ts -> node:fs). It must import nothing server-only.
test('spend-guard.ts stays browser-safe: no import from lib/ops, lib/db or lib/scan, and no node: module but crypto', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/llm/spend-guard.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import\s+(?!type\b)[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.deepEqual(imports.filter(i => /\/(ops|db|scan)\//.test(i) || (i.startsWith('node:') && i !== 'node:crypto')), [], JSON.stringify(imports))
})
