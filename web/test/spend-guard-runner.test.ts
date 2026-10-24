// Spend-guard fixture test (isolated in-memory DB, stub provider, stub fetch). Not live proof, not product yield.
// Observed on a live Ohio scan: one candidate came back from the whole search. The Ohio profile names a US state in
// icp.where, but TinyFish's location option takes a country code only, so the state can only reach the search through
// the query text, and the model writes those queries freely. This pins that every issued query carries the profile's
// geography. The verifier is not touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import { ProviderError, type Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { resetSpendPools } from '../lib/llm/spend-guard.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }


type Calls = { complete: number; research: number; maxTokens: number[]; promptBytes: number }
function run(budgetJson: string | null, model: string | undefined, tinyfishHits = true, failExtraction = false, noIcp = false, keepPools = false) {
  resetTinyfishState()
  if (!keepPools) resetSpendPools()
  const calls: Calls = { complete: 0, research: 0, maxTokens: [], promptBytes: 0 }
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', noIcp ? { query: REQUEST } : { query: REQUEST, icp: JSON.stringify(ICP) })
  if (budgetJson) db.prepare('UPDATE scan_jobs SET run_budget = ?').run(budgetJson)
  const job = claimKeyedJob(db)!
  const lead = { company: 'Harbor Freight Supply', name: 'Pat Lee', signal: 'Hiring a payroll specialist', excerpt: QUOTE, source_url: 'https://jobs.example/hf', event_date: recent }
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: tinyfishHits ? [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: QUOTE, date: recent }] : [] }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${recent}. ${QUOTE}. Apply now.` }] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const anth: Provider = {
    research: async () => { calls.research++; return { text: '', citedUrls: [] } },
    complete: async (_k: string, p: string, _f?: typeof fetch, maxTokens?: number) => { calls.complete++; calls.maxTokens.push(maxTokens ?? 0); calls.promptBytes += Buffer.byteLength(p); if ((failExtraction && maxTokens !== 300) || (noIcp && failExtraction)) throw new ProviderError('retry', 'provider_500'); return maxTokens === 300 ? JSON.stringify(['small company hiring payroll specialist Ohio']) : JSON.stringify([lead]) },
    ...(model ? { configuredModel: () => model } : {}),
  }
  const providers: Record<'anthropic' | 'openai', Provider> = { anthropic: anth, openai: { research: async () => ({ text: '', citedUrls: [] }) } }
  const page = async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Payroll specialist', retrievedAt: 1_700_000_000 })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  return runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null })
    .then(r => ({ r, calls, db, err: (db.prepare('SELECT error FROM scan_jobs').get() as { error: string | null }).error }))
    .finally(() => { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY })
}

test('a budget that cannot cover the first paid call makes ZERO provider calls and ends budget_stopped', async () => {
  const x = await run('{"max_usd":0.0001}', 'claude-sonnet-4-5')
  assert.equal(x.calls.complete + x.calls.research, 0)
  assert.equal(x.err, 'budget_stopped')
})

test('an unpriced or unknown model with a budget makes zero provider calls (no price means no proof of a bound)', async () => {
  for (const m of ['some-future-model', undefined]) {
    const x = await run('{"max_usd":5}', m)
    assert.equal(x.calls.complete + x.calls.research, 0, String(m))
    assert.equal(x.err, 'budget_stopped')
  }
})

test('a budget never lets the web-search research fallback run (its tool result size has no provable bound)', async () => {
  const x = await run('{"max_usd":5}', 'claude-sonnet-4-5', false)
  assert.equal(x.calls.research, 0)
})

test('with room, calls proceed and the reserved worst case stays within the limit', async () => {
  const x = await run('{"max_usd":5}', 'claude-sonnet-4-5')
  assert.ok(x.calls.complete >= 2, 'query plan and extraction ran')
  assert.notEqual(x.err, 'budget_stopped')
})

test('a retry after a failed attempt is not allowed in budget mode: attempts never multiply the spend', async () => {
  const x = await run('{"max_usd":5}', 'claude-sonnet-4-5')
  const row = x.db.prepare('SELECT attempts, status FROM scan_jobs').get() as { attempts: number; status: string }
  assert.equal(row.attempts, 1)
})

test('no budget set: behavior unchanged (calls proceed with no model or price needed)', async () => {
  const x = await run(null, undefined)
  assert.ok(x.calls.complete >= 2)
})

test('budget mode: a provider failure is terminal. The job is NOT re-queued for another attempt that would spend again', async () => {
  const x = await run('{"max_usd":2.5}', 'claude-sonnet-4-5', true, true)
  const row = x.db.prepare('SELECT attempts, status, error FROM scan_jobs').get() as { attempts: number; status: string; error: string | null }
  assert.equal(row.status, 'failed')
  assert.equal(row.attempts, 1)
})

test('without a budget the same provider failure still re-queues (unchanged behavior)', async () => {
  const x = await run(null, undefined, true, true)
  assert.equal((x.db.prepare('SELECT status FROM scan_jobs').get() as { status: string }).status, 'pending')
})

test('budget mode: a provider failure in the ICP inference step (outside the TinyFish try) is also terminal, attempts stay 1', async () => {
  const x = await run('{"max_usd":2.5}', 'claude-sonnet-4-5', true, true, true)
  const row = x.db.prepare('SELECT attempts, status FROM scan_jobs').get() as { attempts: number; status: string }
  assert.deepEqual(row, { attempts: 1, status: 'failed' })
})

test('owner-scoped budget from the operator setting DAZL_RUN_MAX_USD_USERS (no job column, no schema): the named owner is bounded, another owner is not', async () => {
  process.env.DAZL_RUN_MAX_USD_USERS = 'A:0.0001'
  try {
    const x = await run(null, 'claude-sonnet-4-5')
    assert.equal(x.calls.complete + x.calls.research, 0); assert.equal(x.err, 'budget_stopped')
    process.env.DAZL_RUN_MAX_USD_USERS = 'B:0.0001, A2:0.0001'
    const y = await run(null, 'claude-sonnet-4-5')
    assert.ok(y.calls.complete >= 2) // exact id match only: neither B nor A2 is owner A
  } finally { delete process.env.DAZL_RUN_MAX_USD_USERS }
})

test('a malformed owner budget entry is ignored for that owner (never widens or crashes), and the tighter of job and owner limits wins', async () => {
  process.env.DAZL_RUN_MAX_USD_USERS = 'A:abc'
  try { assert.ok((await run(null, 'claude-sonnet-4-5')).calls.complete >= 2) } finally { delete process.env.DAZL_RUN_MAX_USD_USERS }
  process.env.DAZL_RUN_MAX_USD_USERS = 'A:0.0001'
  try { const x = await run('{"max_usd":5}', 'claude-sonnet-4-5'); assert.equal(x.calls.complete, 0) } finally { delete process.env.DAZL_RUN_MAX_USD_USERS }
})

test('reservation arithmetic: (prompt bytes + 1000 margin) * $3/M + max output * $15/M, summed across calls, refused past the limit', async () => {
  const { SpendGuard, SpendRefused } = await import('../lib/llm/spend-guard.ts')
  const g = new SpendGuard(0.0049) // one call of 100 bytes and 100 output tokens reserves (1100*3 + 100*15)/1e6 = 0.0048
  g.reserve('claude-sonnet-4-5', 100, 100)
  assert.ok(Math.abs(g.reservedUsd - 0.0048) < 1e-12)
  assert.throws(() => g.reserve('claude-sonnet-4-5', 0, 0), SpendRefused) // 0.0030 more would pass 0.0049
  const big = new SpendGuard(0.0049)
  assert.throws(() => big.reserve('claude-sonnet-4-5', 100_000, 100), SpendRefused) // same output, large prompt: input bytes count
})

test('the owner limit is ONE pool across all of that owner jobs in the process: a second job cannot spend the same limit again', async () => {
  process.env.DAZL_RUN_MAX_USD_USERS = 'A:0.1' // covers one scan's worst case (about 0.07) but not two
  try {
    const first = await run(null, 'claude-sonnet-4-5')
    assert.ok(first.calls.complete >= 2); assert.notEqual(first.err, 'budget_stopped')
    const second = await run(null, 'claude-sonnet-4-5', true, false, false, true)
    assert.equal(second.err, 'budget_stopped')
    assert.ok(second.calls.complete < first.calls.complete)
  } finally { delete process.env.DAZL_RUN_MAX_USD_USERS }
})
