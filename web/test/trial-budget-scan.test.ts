// A free-trial scan inside the runner (lib/billing/trial-budget.ts, lib/scan/runner.ts), with the proposed per-scan
// ceiling of $0.30 (not approved spend): every paid step on dazl's keys reserves its MAXIMUM cost before it is sent -
// model calls by prompt bytes plus margin and max_tokens, TinyFish at a fixed price per search and fetched URL - and a
// step that does not fit is never sent. The model's own web search has no cost bound and is never made on a trial.
// Failed calls keep their charge; a retried attempt starts from what the job already reserved; a worker that lost the
// job to another cannot spend on it. A scan that reaches its ceiling stops, keeps what it found in the review lane and
// says why. Owner-funded calls outside a scan are off for trial accounts. Stubs only: no network, no key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob, getJob } from '../lib/scan/store.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { migrateTrial } from '../lib/scan/trial.ts'
import { claimKeyedJob, previewIcp, runJob } from '../lib/scan/runner.ts'
import { icpFromWebsite } from '../lib/scan/icp-from-site.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { migrateTinyfish, resetTinyfishState, tfSearch } from '../lib/search/tinyfish.ts'
import { migrateTrialBudget } from '../lib/billing/trial-budget.ts'
import { INPUT_MARGIN_TOKENS, PRICES_USD_PER_M, SpendGuard, SpendRefused, reserveAllUsd, researchCostUsd } from '../lib/llm/spend-guard.ts'

const SEARCH_USD = 0.05, FETCH_USD = 0.01, CEILING = 0.30
const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: String(CEILING), DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: String(SEARCH_USD), DAZL_TRIAL_TINYFISH_FETCH_USD: String(FETCH_USD) }
const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const ICP = JSON.stringify({ summary: 'Toronto dental practices hiring', who: ['Owner'], industries: ['dental'], sizes: [], where: ['Toronto'], signals: ['hiring a receptionist'], exclude: [] })
const setup = () => { const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migrateTrial(db); resetTinyfishState(); return db }
const trialJob = (db: Database.Database, reservedBefore = 0) => {
  const id = createQueryJob(db, 'keyless', { query: 'dental practices in Toronto hiring a receptionist', icp: ICP })
  db.prepare("UPDATE scan_jobs SET funded_by = 'trial', spend_reserved_usd = ? WHERE id = ?").run(reservedBefore, id)
  return id
}
const recorded = (db: Database.Database, id: string) => (db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs WHERE id = ?').get(id) as { s: number }).s
// What each sent model call can cost at most, priced independently of the guard: prompt bytes + margin in, max_tokens out
const P = PRICES_USD_PER_M['claude-sonnet-4-5']
const modelMax = (prompt: string, max: number) => ((Buffer.byteLength(prompt) + INPUT_MARGIN_TOKENS) * P.in + max * P.out) / 1e6
// A model that records every call it is sent; research (the model's own web search) must never be one of them
const model = (sent: { kind: string; usd: number }[]): Provider => ({
  configuredModel: () => 'claude-sonnet-4-5',
  research: async () => { sent.push({ kind: 'research', usd: Infinity }); return { text: '[]', citedUrls: [] } },
  complete: async (_k, prompt, _f, max = 10) => { sent.push({ kind: 'complete', usd: modelMax(prompt, max) }); return '[]' },
})
// TinyFish on loopback: each search request recorded; `answer` picks the reply (ok and empty by default)
const tinyfish = async (sent: { kind: string; usd: number }[], fn: () => Promise<void>, answer: (n: number) => Response | Promise<Response> = () => new Response(JSON.stringify({ results: [] }), { status: 200 }), price = SEARCH_USD) => {
  const real = globalThis.fetch
  let n = 0
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u)
    if (url.startsWith('https://api.search.tinyfish.ai')) { sent.push({ kind: 'search', usd: price }); return answer(++n) }
    // the token counter's answer is an estimate, not a bound: a trial never asks it (recorded at no cost if it did)
    if (url.includes('/count_tokens')) { sent.push({ kind: 'count', usd: 0 }); return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 }) }
    throw new Error(`Unexpected network call: ${url}`)
  }) as typeof fetch
  try { await fn() } finally { globalThis.fetch = real }
}
const total = (sent: { usd: number }[]) => sent.reduce((a, c) => a + c.usd, 0)

test('per-scan ceiling: every step is reserved at its maximum before it is sent; the step that would pass $0.30 is never sent', async () => {
  // searches at $0.12: the query plan (~$0.01) and two searches fit, the third would pass $0.30
  const BIG = 0.12
  await withEnv({ ...TRIAL_ENV, DAZL_TRIAL_TINYFISH_SEARCH_USD: String(BIG) }, async () => {
    const db = setup(); const id = trialJob(db)
    const sent: { kind: string; usd: number }[] = []
    await tinyfish(sent, async () => {
      assert.equal(await runJob(db, claimKeyedJob(db)!, { providers: { anthropic: model(sent), openai: model(sent) }, judge: null }), 'done')
    }, undefined, BIG)
    const searches = sent.filter(c => c.kind === 'search').length
    assert.equal(searches, 2, 'two searches fit; the third was refused before its request')
    assert.ok(!sent.some(c => c.kind === 'research'), "the model's own web search (no cost bound) is never sent on a trial")
    assert.ok(sent.some(c => c.kind === 'complete'), 'model calls were sent, each reserved by its prompt bytes')
    assert.ok(!sent.some(c => c.kind === 'count'), 'never by the token counter\'s estimate')
    // what was sent, priced at its maximum independently, is exactly what the scan recorded, and within the ceiling
    assert.ok(Math.abs(recorded(db, id) - total(sent)) < 1e-9, `recorded ${recorded(db, id)} = sent maxima ${total(sent)}`)
    assert.ok(recorded(db, id) <= CEILING + 1e-9, `recorded ${recorded(db, id)} <= ${CEILING}`)
    assert.ok(recorded(db, id) + BIG > CEILING, 'it stopped because the next search would have passed the ceiling')
    const job = getJob(db, 'keyless', id)!
    assert.deepEqual([job.status, job.error], ['done', 'trial_budget_reached'])
    const o = scanOutcome({ ...job, id, status: job.status, error: job.error, funded_by: 'trial' } as never)
    assert.equal(o.label, 'Stopped early: this free scan reached its spending limit before it found any companies.')
  })
})

test('per-scan ceiling: a failed search keeps its charge; a trial with nothing found ends as stopped, never falling back to unbounded research', async () => {
  await withEnv(TRIAL_ENV, async () => {
    const db = setup(); const id = trialJob(db)
    const sent: { kind: string; usd: number }[] = []
    await tinyfish(sent, async () => {
      assert.equal(await runJob(db, claimKeyedJob(db)!, { providers: { anthropic: model(sent), openai: model(sent) }, judge: null }), 'failed')
    }, () => new Response('upstream error', { status: 500 }))
    assert.deepEqual(sent.map(c => c.kind).filter(k => k !== 'complete'), ['search'], 'one search, which failed; no research after it')
    assert.ok(Math.abs(recorded(db, id) - total(sent)) < 1e-9, 'the failed search is counted like a successful one')
    const job = getJob(db, 'keyless', id)!
    assert.deepEqual([job.status, job.error], ['failed', 'budget_stopped'])
    const o = scanOutcome({ ...job, id, status: job.status, error: job.error, funded_by: 'trial' } as never)
    assert.equal(o.label, 'This free scan found no companies within its spending limit')
    assert.match(o.detail ?? '', /does not show that no company matches/)
  })
})

test('per-scan ceiling across retries: an attempt starts from what the job already reserved, so a retry cannot spend the ceiling again', async () => {
  await withEnv(TRIAL_ENV, async () => {
    // an earlier attempt of this job reserved $0.27: what is left ($0.03) fits no $0.05 search
    const db = setup(); const id = trialJob(db, 0.27)
    const sent: { kind: string; usd: number }[] = []
    await tinyfish(sent, async () => { await runJob(db, claimKeyedJob(db)!, { providers: { anthropic: model(sent), openai: model(sent) }, judge: null }) })
    assert.equal(sent.filter(c => c.kind === 'search').length, 0, 'no search was sent')
    assert.ok(recorded(db, id) <= CEILING + 1e-9, `recorded ${recorded(db, id)} <= ${CEILING}`)
    assert.ok(Math.abs(recorded(db, id) - (0.27 + total(sent))) < 1e-9)
    assert.equal(getJob(db, 'keyless', id)!.error, 'trial_budget_reached')
  })
})

test('concurrent workers: a worker whose job was re-claimed by another attempt cannot spend on it; its next step is never sent', async () => {
  await withEnv(TRIAL_ENV, async () => {
    const db = setup(); const id = trialJob(db)
    const sent: { kind: string; usd: number }[] = []
    // during the first search another worker re-claims the job (a new attempt): this worker no longer owns it
    await tinyfish(sent, async () => { await runJob(db, claimKeyedJob(db)!, { providers: { anthropic: model(sent), openai: model(sent) }, judge: null }) }, n => {
      if (n === 1) db.prepare('UPDATE scan_jobs SET attempts = attempts + 1 WHERE id = ?').run(id)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    })
    assert.equal(sent.filter(c => c.kind === 'search').length, 1, 'the stale worker sent nothing after losing the job')
    assert.ok(!sent.some(c => c.kind === 'research'))
    assert.ok(Math.abs(recorded(db, id) - total(sent)) < 1e-9, 'its spend stays recorded on the job for the next attempt to start from')
  })
})

test('the trial reservation settles only when the run has ended: every paid call happened before it, and after the scan read done', async () => {
  await withEnv(TRIAL_ENV, async () => {
    const db = setup(); migrateTrialBudget(db); const id = trialJob(db)
    db.prepare("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES ('r1', 'keyless', ?, 0.3, 1, 1)").run(id)
    const settledAt = () => (db.prepare("SELECT settled_at AS s FROM trial_reservations WHERE id = 'r1'").get() as { s: number | null }).s
    const sent: { kind: string; usd: number }[] = []
    const unsettledAtCall: boolean[] = []
    const m = model(sent)
    const watched: Provider = { ...m, complete: async (k, p, f, max) => { unsettledAtCall.push(settledAt() === null); return m.complete!(k, p, f, max) } }
    await tinyfish(sent, async () => { await runJob(db, claimKeyedJob(db)!, { providers: { anthropic: watched, openai: watched }, judge: null }) },
      () => { unsettledAtCall.push(settledAt() === null); return new Response(JSON.stringify({ results: [] }), { status: 200 }) })
    assert.ok(unsettledAtCall.length >= 2 && unsettledAtCall.every(Boolean), 'every paid call ran while the reservation still counted in full')
    const row = db.prepare('SELECT status, finished_at FROM scan_jobs WHERE id = ?').get(id) as { status: string; finished_at: number }
    assert.ok(['done', 'failed'].includes(row.status))
    assert.ok(settledAt() !== null && settledAt()! >= row.finished_at, 'settled at or after the scan finished')
  })
})

test('owner-funded calls outside a scan are off for a trial account: the profile preview and website analysis call no model', async () => {
  await withEnv(TRIAL_ENV, async () => {
    const db = setup()
    let calls = 0
    const p: Provider = { configuredModel: () => 'claude-sonnet-4-5', research: async () => { calls++; return { text: '', citedUrls: [] } }, complete: async () => { calls++; return '{}' } }
    const out = await previewIcp(db, 'keyless', 'dental practices in Toronto hiring a receptionist', { providers: { anthropic: p, openai: p } }, '1.2.3.4')
    assert.ok('icp' in out && out.inferred === false, JSON.stringify(out))
    let fetched = 0
    const site = await icpFromWebsite(db, 'keyless', 'https://acme.example', { providers: { anthropic: p, openai: p }, lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as never, fetchImpl: (async () => { fetched++; return new Response('') }) as typeof fetch } as never)
    // The free website read may fetch the public page (it costs nothing) but never calls a model; an unreadable
    // page ends as a typed fetch error (empty/non-HTML body here), not as a key demand.
    assert.ok('error' in site && site.error === 'not_html', JSON.stringify(site))
    assert.deepEqual([calls, fetched], [0, 1])
  })
})

test('TinyFish: the trial charge runs before each paid search and fetch; a refusal makes no request', async () => {
  const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState()
  const env = { TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '1' }
  let requests = 0
  const fetchImpl = (async () => { requests++; return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as typeof fetch
  const guard = new SpendGuard(0.025); guard.label = 'trial_budget'
  const charge = async (kind: 'search' | 'fetch', units: number) => { await reserveAllUsd([guard], units * (kind === 'search' ? 0.01 : 0.002)) }
  const spent = { searches: 0 }
  assert.equal((await tfSearch(db, 't', 'q1', {}, spent, { env, fetchImpl, charge })).ok, true)
  assert.equal((await tfSearch(db, 't', 'q2', {}, spent, { env, fetchImpl, charge })).ok, true)
  await assert.rejects(tfSearch(db, 't', 'q3', {}, spent, { env, fetchImpl, charge }), (e: unknown) => e instanceof SpendRefused && e.reason === 'trial_budget')
  assert.equal(requests, 2, 'the third search was refused before any request')
  assert.ok(Math.abs(guard.reservedUsd - 0.02) < 1e-9)
  assert.equal(guard.refused, true)
})

test('research cost: tokens at the listed price plus $0.01 per web search; no usage or no price means unknown', () => {
  assert.ok(Math.abs(researchCostUsd({ model: 'claude-sonnet-4-5', input_tokens: 100_000, output_tokens: 2_000, web_search_requests: 4 }, undefined)! - 0.37) < 1e-9) // 0.30 in + 0.03 out + 4 searches
  assert.equal(researchCostUsd(undefined, 'claude-sonnet-4-5'), null)
  assert.equal(researchCostUsd({ model: 'unlisted', input_tokens: 1, output_tokens: 1 }, undefined), null)
  // settling: below the reserve releases the difference; above it is recorded and refuses what comes next
  const g = new SpendGuard(1); g.reserveUsd(0.5); g.settle(-0.2); assert.ok(Math.abs(g.reservedUsd - 0.3) < 1e-9); assert.equal(g.refused, false)
  g.settle(0.9); assert.ok(Math.abs(g.reservedUsd - 1.2) < 1e-9); assert.equal(g.refused, true)
  assert.throws(() => g.reserveUsd(0.01), SpendRefused)
})
