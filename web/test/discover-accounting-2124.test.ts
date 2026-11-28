// #2124 (launch blocker): a scan failed one second in with accounting_uncertain while a $0.75 web_search reservation was held and NO model
// call or search had run. Two source defects, each with a RUNNER-LEVEL failing-first control at the real terminal/ledger path (runJob):
//  (1) first-pass pre-dispatch SpendRefused reported source_error instead of an honest budget/refusal stop;
//  (2) a dispatched unknown-usage call must end accounting_uncertain with the hold kept - never done, never turned into $0, never retried.
// A SpendRefused is thrown BEFORE a request is sent (cost $0); an unknown provider response is NOT $0 and stays held.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { runDiscovery, type DiscoveryDeps } from '../lib/discover/run.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { ProviderError } from '../lib/llm/provider.ts'

// ---- runDiscovery (unit) --------------------------------------------------------------------------------------------------------
const input = { query: 'dental practices in Ohio' }
const budget = { maxUsd: 5, wantShown: 5 }
const empty = { leads: [], seen: [], usage: { usd: 0, searches: 0, requests: 0 }, stop: 'done', model: 'stub', note: null }
const deps = (discover: unknown): DiscoveryDeps => ({ apiKey: 'sk-test', discover: discover as never, enrich: null, judge: null })

test('#2124 a SpendRefused on the second pass is a clean refusal, never accounting_uncertain (nothing was sent)', async () => {
  let n = 0
  const discover = async () => { n++; if (n === 1) return empty; throw new SpendRefused('over_cap') }
  const run = await runDiscovery(input, budget, deps(discover))
  assert.equal(n, 2, 'the second pass ran and was refused')
  assert.notEqual(run.accountingUncertain, true, 'a refused (never-sent) step is not uncertain')
  assert.notEqual(run.stop, 'accounting_uncertain', 'and the run does not claim accounting_uncertain')
})
test('#2124 control: a genuinely maybe-billed failure on the second pass IS accounting_uncertain', async () => {
  let n = 0
  const discover = async () => { n++; if (n === 1) return empty; throw new ProviderError('retry', 'server_error', 'uncertain') }
  const run = await runDiscovery(input, budget, deps(discover))
  assert.equal(run.accountingUncertain, true, 'a request that may have been billed stays uncertain')
})

// ---- the real runner terminal + ledger path (runJob) --------------------------------------------------------------------------
const setup = () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' }) as string
  const job = claimKeyedJob(db, id)!
  return { db, job, id, master }
}
const answer = (usd: number, stop = 'end_turn'): DiscoverResult => ({ leads: [], seen: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd }, stop, model: 'm', note: null })
const spendOf = (db: Database.Database, id: string) => (db.prepare('SELECT actual_usd FROM scan_spend_calls WHERE scan_job_id = ?').all(id) as { actual_usd: number | null }[]).map(s => s.actual_usd)
const jobOf = (db: Database.Database, id: string) => db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number }

test('#2124 runner: first-pass pre-dispatch SpendRefused is an honest budget stop, never source_error, settled to $0', async () => {
  const { db, job, id, master } = setup()
  const r = await runJob(db, job, { master, discover: true, enrichImpl: null, discoverImpl: async () => { throw new SpendRefused('over_cap') } })
  assert.equal(r, 'failed')
  const j = jobOf(db, id)
  assert.equal(j.status, 'failed')
  assert.equal(j.error, 'budget_stopped', 'a budget refusal result, not source_error')
  assert.deepEqual(spendOf(db, id), [0], 'nothing was dispatched: settled at $0')
})

test('#2124 runner: a dispatched unknown-usage call ends accounting_uncertain with the hold kept (not done, not $0, no retry)', async () => {
  const { db, job, id, master } = setup()
  let n = 0
  const r = await runJob(db, job, { master, discover: true, enrichImpl: null, discoverImpl: async () => { n++; if (n === 1) return answer(0.05); throw new ProviderError('retry', 'server_error', 'uncertain') } })
  assert.equal(r, 'failed')
  const j = jobOf(db, id)
  assert.equal(j.status, 'failed', 'a dispatched uncertain call never ends done')
  assert.equal(j.error, 'accounting_uncertain', 'the terminal uncertainty contract')
  assert.equal(j.attempts, 1, 'never auto-retried')
  assert.deepEqual(spendOf(db, id), [null], 'the hold is kept, never turned into $0')
})

test('#2124 runner control: a normal one-dispatch run is done and settled at what it spent', async () => {
  const { db, job, id, master } = setup()
  const r = await runJob(db, job, { master, discover: true, enrichImpl: null, discoverImpl: async () => answer(0.044, 'search_cap') })
  assert.equal(r, 'done')
  const j = jobOf(db, id)
  assert.deepEqual([j.status, j.error], ['done', null])
  assert.deepEqual(spendOf(db, id), [0.044], 'settled at the run\'s own spend')
})

test('#2124 runner mixed control: prior spend then a late refusal is done and settled at the prior spend, never held', async () => {
  const { db, job, id, master } = setup()
  let n = 0
  const r = await runJob(db, job, { master, discover: true, enrichImpl: null, discoverImpl: async () => { n++; if (n === 1) return answer(0.05); throw new SpendRefused('over_cap') } })
  assert.equal(r, 'done')
  const j = jobOf(db, id)
  assert.deepEqual([j.status, j.error], ['done', null], 'a late refusal after real spend is not uncertainty')
  assert.deepEqual(spendOf(db, id), [0.05], 'settled at the prior spend, not held')
})
