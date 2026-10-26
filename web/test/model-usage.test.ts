import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { meterProvider, modelUsage, writeModelCalls, stageOfPrompt, type ModelCall } from '../lib/scan/model-usage.ts'
import { icpPrompt } from '../lib/scan/icp.ts'
import { ProviderError, type Provider } from '../lib/llm/provider.ts'
import { guardProvider, SpendGuard, SpendRefused } from '../lib/llm/spend-guard.ts'

// Model usage tracking for the ordinary route (live acceptance run, Oct 26). Stubs only: no network, no key, no price.
const stub = (over: Partial<Provider> = {}): Provider => ({
  research: async () => ({ text: 'r', citedUrls: [] }),
  configuredModel: () => 'claude-test-requested',
  completeDetailed: async () => ({ text: 'hello', model: 'claude-test-served', usage: { input_tokens: 100, output_tokens: 7 } }),
  ...over,
})

test('meter: served model and reported tokens are kept; complete() returns the same text; requested != served is visible', async () => {
  const calls: ModelCall[] = []
  const p = meterProvider(stub(), c => calls.push(c))
  assert.equal(await p.complete!('k', icpPrompt('roofers in Ohio'), undefined, 800), 'hello')
  await p.completeDetailed!('k', 'Reply with ONLY a JSON array of leads', undefined, 3000)
  assert.deepEqual(calls.map(c => [c.stage, c.method, c.model_requested, c.model_served, c.input_tokens, c.output_tokens, c.max_tokens]), [
    ['profile', 'completeDetailed', 'claude-test-requested', 'claude-test-served', 100, 7, 800],
    ['extraction', 'completeDetailed', 'claude-test-requested', 'claude-test-served', 100, 7, 3000],
  ])
  assert.ok(calls.every(c => c.outcome === 'ok'))
  assert.equal(stageOfPrompt('something unrecognised'), 'other')
})

test('meter: unreported usage and research calls stay NULL, never 0; errors are recorded and rethrown unchanged', async () => {
  const calls: ModelCall[] = []
  const noUsage = meterProvider(stub({ completeDetailed: async () => ({ text: 't', model: null }) }), c => calls.push(c))
  await noUsage.complete!('k', 'p', undefined, 10)
  await noUsage.research('k', 'find leads')
  assert.deepEqual(calls.map(c => [c.method, c.model_served, c.input_tokens, c.output_tokens]), [['completeDetailed', null, null, null], ['research', null, null, null]])
  const bad = meterProvider(stub({ completeDetailed: async () => { throw new ProviderError('retry', 'provider_529') } }), c => calls.push(c))
  await assert.rejects(() => bad.complete!('k', 'p'), (e: unknown) => e instanceof ProviderError && e.kind === 'retry' && e.message === 'provider_529')
  assert.equal(calls.at(-1)!.outcome, 'error')
  // a recorder that throws never breaks the call
  const throwing = meterProvider(stub(), () => { throw new Error('db down') })
  assert.equal(await throwing.complete!('k', 'p'), 'hello')
  // a double with only complete(): counted, usage unknown
  const only = meterProvider({ research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'x' }, c => calls.push(c))
  assert.equal(await only.complete!('k', 'p'), 'x'); assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.input_tokens], ['complete', null])
})

test('spend guard outside the meter: a refused request is never recorded as sent', async () => {
  const calls: ModelCall[] = []
  const guarded = guardProvider(meterProvider(stub(), c => calls.push(c)), new SpendGuard(0.000001))
  await assert.rejects(() => guarded.complete!('k', 'x'.repeat(5000), undefined, 4000), (e: unknown) => e instanceof SpendRefused)
  assert.equal(calls.length, 0)
})

function mk() { const db = new Database(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateScan(db); return db }
const call = (over: Partial<ModelCall> = {}): ModelCall => ({ stage: 'extraction', method: 'completeDetailed', model_requested: 'm', model_served: 'm-served', input_tokens: 10, output_tokens: 2, outcome: 'ok', max_tokens: 100, prompt_chars: 50, ...over })

test('read: totals only from reported numbers, tokens_complete false when any request lacks them, tenant-scoped, no rows is recorded:false with nulls', () => {
  const db = mk(); const job = createQueryJob(db, 'A', { query: 'q' } as never)
  assert.deepEqual([modelUsage(db, 'A', job).recorded, modelUsage(db, 'A', job).input_tokens, modelUsage(db, 'A', job).requests], [false, null, 0])
  assert.equal(writeModelCalls(db, 'A', job, 1, [call(), call({ input_tokens: null, output_tokens: null, model_served: null, method: 'research', stage: 'research' }), call({ outcome: 'error' })], {}), true)
  const u = modelUsage(db, 'A', job)
  assert.deepEqual([u.recorded, u.requests, u.input_tokens, u.output_tokens, u.tokens_complete, u.errors, u.served_models, u.by_stage], [true, 3, 20, 4, false, 1, ['m-served'], { extraction: 2, research: 1 }])
  assert.equal(modelUsage(db, 'B', job).recorded, false, 'another tenant sees nothing')
  assert.equal(writeModelCalls(db, 'A', job, 2, [call()], { DAZL_MODEL_USAGE: '0' }), false, 'kill switch')
  assert.equal(modelUsage(db, 'A', job).requests, 3)
  db.prepare('DELETE FROM scan_jobs WHERE id = ?').run(job)
  assert.equal((db.prepare('SELECT count(*) n FROM scan_model_calls').get() as { n: number }).n, 0, 'rows go with the job')
})

// End to end through the real runner: the model requests of a scan that FAILS (no_candidates, like the London run) are kept.
const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
test('runner: a scan that ends in no_candidates still leaves its model requests; the status counts match the stub', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const id = createQueryJob(db, 'A', { query: 'Find London seed-funded companies hiring sales', icp: JSON.stringify({ summary: 's', who: ['Founder'], industries: [], sizes: [], where: ['London'], signals: [], exclude: [] }) } as never)
  const providers = { anthropic: stub({ research: async () => ({ text: '[]', citedUrls: [] }) }), openai: stub() } as Record<'anthropic' | 'openai', Provider>
  const out = await runJob(db, claimKeyedJob(db, id)!, { providers, master, fetchPage: async () => null as never, judge: null, score: false, ground: false })
  assert.equal(out, 'failed')
  const u = modelUsage(db, 'A', id)
  // exactly the one web-research request the stub received, with no usage reported: counted, tokens null (not 0)
  assert.deepEqual([u.recorded, u.requests, u.by_stage, u.input_tokens, u.output_tokens, u.tokens_complete, u.requested_models, u.served_models], [true, 1, { research: 1 }, null, null, false, ['claude-test-requested'], []])
  assert.equal(modelUsage(db, 'B', id).recorded, false)
})

import { previewIcp } from '../lib/scan/runner.ts'
test('profile generation (before any job) is recorded by tenant with job_id null, success or failure', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const ok = { anthropic: stub({ completeDetailed: async () => ({ text: '{"summary":"Roofers in Ohio","who":[],"industries":[],"sizes":[],"where":["Ohio"],"signals":[],"exclude":[]}', model: 'served-1', usage: { input_tokens: 300, output_tokens: 90 } }) }), openai: stub() } as Record<'anthropic' | 'openai', Provider>
  const r = await previewIcp(db, 'A', 'roofers in Ohio', { providers: ok, master })
  assert.ok('icp' in r && r.inferred)
  const bad = { anthropic: stub({ completeDetailed: async () => { throw new ProviderError('retry', 'provider_500') } }), openai: stub() } as Record<'anthropic' | 'openai', Provider>
  await previewIcp(db, 'A', 'roofers in Ohio', { providers: bad, master })
  const rows = db.prepare('SELECT tenant_id, job_id, stage, model_served, input_tokens, outcome FROM scan_model_calls ORDER BY rowid').all()
  assert.deepEqual(rows, [{ tenant_id: 'A', job_id: null, stage: 'profile', model_served: 'served-1', input_tokens: 300, outcome: 'ok' }, { tenant_id: 'A', job_id: null, stage: 'profile', model_served: null, input_tokens: null, outcome: 'error' }])
})
