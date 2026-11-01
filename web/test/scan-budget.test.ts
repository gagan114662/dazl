// Whole-scan budget harness. No sleeps stand in for provider latency: a controlled clock drives the admission
// guard, deferred promises model late completion, and the transport abort is the real AbortSignal path.
process.env.SCAN_LLM_TIMEOUT_MS = '50' // read once at provider.ts load, so it must be set before the dynamic imports
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'

const { claimKeyedJob, runJob, scanJobBudgetMs } = await import('../lib/scan/runner.ts')
const { migrateKeys, saveKey } = await import('../lib/llm/key-store.ts')
const { migrateScan, createJob, getJob, listLeads, cancelJob } = await import('../lib/scan/store.ts')
const { anthropicProvider } = await import('../lib/llm/provider.ts')

// AbortSignal.timeout timers are unref'd; a live handle (the server, in production) keeps the loop running for them.
const keepAlive = setInterval(() => {}, 1_000)
after(() => clearInterval(keepAlive))
const KA = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const cand = JSON.stringify([{ name: 'Pat', company: 'Northside Builders', contact: null, signal: 'Hiring', source_url: 'https://a.com', score: 80, excerpt: QUOTE, event_date: '2026-10-01' }])
const found = { text: cand, citedUrls: ['https://a.com'] }

function rig() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  const master = randomBytes(32)
  saveKey(db, 'A', 'anthropic', KA, master)
  const id = createJob(db, 'A', { business_name: 'Acme Roofing', industry: 'roofing', location: 'Toronto' })
  return { db, master, id }
}
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
const wrap = (research: () => Promise<{ text: string; citedUrls: string[] }>) => ({ anthropic: { research }, openai: { research } }) as never

test('controlled clock: past the budget the NEXT phase is refused once as scan_timeout, no retry, nothing saved', async () => {
  const { db, master, id } = rig()
  const job = claimKeyedJob(db)!
  let t = 1_000, calls = 0
  const providers = wrap(async () => { calls++; t += 5_000; return found }) // the call itself "takes" 5 s of fake time
  const out = await runJob(db, job, { providers, master, jobBudgetMs: 1_000, clock: () => t, score: false })
  assert.equal(out, 'failed')
  const j = getJob(db, 'A', id)!
  assert.equal(j.status, 'failed'); assert.equal(j.error, 'scan_timeout')
  assert.equal(listLeads(db, 'A', id).length, 0)
  assert.equal(calls, 1)
  // a stale re-run of the same attempt object is fenced: row is not 'running', nothing changes
  assert.equal(await runJob(db, job, { providers, master, jobBudgetMs: 1_000, clock: () => t, score: false }), 'done')
  assert.equal(calls, 1, 'stale attempt started no provider work')
  assert.equal(getJob(db, 'A', id)!.error, 'scan_timeout')
})

test('NEVER-resolving provider: the budget does NOT release the run (admission guard only); job stays running', async () => {
  const { db, master, id } = rig()
  const job = claimKeyedJob(db)!
  let t = 0
  const never = new Promise<never>(() => {})
  let settled = false
  const run = runJob(db, job, { providers: wrap(() => never), master, jobBudgetMs: 10, clock: () => t, score: false }).then(r => { settled = true; return r })
  t += 10_000_000
  await flush()
  assert.equal(settled, false, 'an awaited call that never settles holds runJob; the budget cannot end it')
  assert.equal(getJob(db, 'A', id)!.status, 'running')
  void run
})

test('transport abort is the real hard bound on the live provider; the retired research path makes no fetch at all (#379)', async () => {
  // The abort bound now lives where live provider calls still exist: complete. A fetch that never answers is aborted
  // at the 50 ms transport timeout - no hang.
  const hangingFetch = ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch
  const t0 = Date.now()
  await assert.rejects(anthropicProvider.complete('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'prompt', hangingFetch), /network_or_timeout/)
  assert.ok(Date.now() - t0 < 3_000, 'settled at the 50 ms transport timeout, not hung')
  // #379: the unguarded plain-job scan's only provider call was research, which is retired at the real provider
  // boundary - the job fails honestly budget_stopped with ZERO fetch attempts (no spend is even possible), instead of
  // the old re-pend-and-retry-unpriced-research loop.
  const { db, master, id } = rig()
  let calls = 0
  const countingFetch = ((...a: unknown[]) => { calls++; return (hangingFetch as (...b: unknown[]) => unknown)(...a) }) as unknown as typeof fetch
  const providers = { anthropic: anthropicProvider, openai: anthropicProvider } as never
  assert.equal(await runJob(db, claimKeyedJob(db)!, { providers, master, fetchImpl: countingFetch, score: false }), 'failed')
  const j = getJob(db, 'A', id)!
  assert.equal(j.status, 'failed'); assert.equal(j.error, 'budget_stopped')
  assert.equal(calls, 0, 'retired research attempted no fetch')
})

test('reap + late completion + ownership loss: the old attempt finishing late writes nothing and does not touch the new attempt', async () => {
  const { db, master, id } = rig()
  const job1 = claimKeyedJob(db)!
  const gate = deferred<{ text: string; citedUrls: string[] }>()
  const run1 = runJob(db, job1, { providers: wrap(() => gate.promise), master, score: false })
  await flush()
  db.prepare("UPDATE scan_jobs SET claimed_at = claimed_at - 5000 WHERE id = ?").run(id) // lease expired
  assert.equal(getJob(db, 'A', id)!.status, 'pending') // read-time reaper re-pends it
  const job2 = claimKeyedJob(db)!
  assert.equal(job2.attempts, job1.attempts + 1)
  gate.resolve(found) // attempt 1's provider call returns late
  assert.equal(await run1, 'done') // stale: ScanStopped, a no-op
  const row = db.prepare('SELECT status, attempts, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number; error: string | null }
  assert.deepEqual({ status: row.status, attempts: row.attempts, error: row.error }, { status: 'running', attempts: job2.attempts, error: null })
  assert.equal(listLeads(db, 'A', id).length, 0)
})

test('late completion after a user stop with an expired budget: stop wins, no leads, stays cancelled', async () => {
  const { db, master, id } = rig()
  const job = claimKeyedJob(db)!
  const gate = deferred<{ text: string; citedUrls: string[] }>()
  let t = 0
  const run = runJob(db, job, { providers: wrap(() => gate.promise), master, jobBudgetMs: 10, clock: () => t, score: false })
  await flush()
  cancelJob(db, 'A', id); t += 1_000
  gate.resolve(found)
  assert.equal(await run, 'done')
  assert.equal(getJob(db, 'A', id)!.error, 'cancelled')
  assert.equal(listLeads(db, 'A', id).length, 0)
})

test('budget is OFF by default and for invalid values; CSV company jobs never get a deadline', async () => {
  assert.equal(scanJobBudgetMs({}), null)
  assert.equal(scanJobBudgetMs({ SCAN_JOB_BUDGET_MS: '' }), null)
  assert.equal(scanJobBudgetMs({ SCAN_JOB_BUDGET_MS: 'abc' }), null)
  assert.equal(scanJobBudgetMs({ SCAN_JOB_BUDGET_MS: '-1' }), null)
  assert.equal(scanJobBudgetMs({ SCAN_JOB_BUDGET_MS: '5000' }), 5000)
  const { db, master, id } = rig()
  db.prepare("UPDATE scan_jobs SET csv_domain = 'acme.com' WHERE id = ?").run(id)
  const job = claimKeyedJob(db)!
  assert.equal(job.csv_domain, 'acme.com')
  let t = 0
  const providers = wrap(async () => { t += 10_000_000; return found })
  // expired "budget" on a CSV job: no ScanTimedOut; it proceeds to verification (page fetch stubbed to fail verification)
  const out = await runJob(db, job, { providers, master, jobBudgetMs: 1, clock: () => t, score: false, fetchPage: async () => null as never })
  assert.notEqual(getJob(db, 'A', id)!.error, 'scan_timeout')
  assert.ok(['done', 'failed', 'retry'].includes(out))
})

test('queue integration: scan_timeout fails the domain row AND the queue item non-retryably; a second kick runs nothing; slot released', async () => {
  const { SqliteQueue } = await import('../lib/queue/sqlite.ts')
  const { kickQueueRunner } = await import('../lib/scan/queue-runner.ts')
  const { slotAvailable } = await import('../lib/scan/run-slots.ts')
  const { db, master, id } = rig()
  let t = 0, calls = 0
  const providers = wrap(async () => { calls++; t += 10_000; return found })
  const deps = { providers, master, jobBudgetMs: 1_000, clock: () => t, score: false }
  await kickQueueRunner(db, deps, runJob)
  for (let i = 0; i < 30 && getJob(db, 'A', id)!.status === 'running'; i++) await flush()
  await flush()
  const row = db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number }
  assert.deepEqual(row, { status: 'failed', error: 'scan_timeout', attempts: 1 })
  assert.equal(new SqliteQueue(db).get(id)!.status, 'failed')
  assert.equal(slotAvailable(), true)
  await kickQueueRunner(db, deps, runJob); await flush()
  assert.equal(calls, 1, 'no second provider call: the failure is not retried by the queue')
})
