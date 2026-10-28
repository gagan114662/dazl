// A free-trial scan inside the runner (lib/billing/trial-budget.ts, lib/scan/runner.ts): every paid step on dazl's keys
// counts against the scan's reserve; web research stays on until the reserve is reached; a scan that reaches it stops,
// keeps what it found in the review lane (never as verified), and its status says why in plain words. Stubs only: no
// network, no key; TinyFish runs against a local fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, getJob, listLeads } from '../lib/scan/store.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { migrateTrial } from '../lib/scan/trial.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { migrateTinyfish, resetTinyfishState, tfSearch } from '../lib/search/tinyfish.ts'
import { SpendGuard, SpendRefused, reserveAllUsd, researchCostUsd } from '../lib/llm/spend-guard.ts'

const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_USER_DAILY_USD: '3', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', DAZL_TRIAL_RESEARCH_RESERVE_USD: '0.5' }
const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = (url: string) => ({ name: 'Pat', company: 'Northside Builders', contact: null, signal: 'Hiring', source_url: url, score: 80, excerpt: QUOTE, event_date: recent })
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. ${'More text about the roofing market. '.repeat(10)}`, title: 'Northside Builders news', retrievedAt: 1_700_000_000 })
// counting tokens before a model call is Anthropic's free count endpoint; locally it answers 5,000
const countFetch = (async (u: unknown) => String(u).includes('count_tokens') ? new Response(JSON.stringify({ input_tokens: 5000 }), { status: 200 }) : (() => { throw new Error(`Unexpected network call: ${String(u)}`) })()) as typeof fetch
const trialJob = (db: Database.Database) => {
  const id = createJob(db, 'keyless', { business_name: 'Acme Roofing', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(id)
  return id
}
const setup = () => { const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migrateTrial(db); return db }

test('a trial scan that reaches its limit after finding leads stops, keeps them in review, and says why', async () => {
  await withEnv(TRIAL_ENV, async () => {
    const db = setup(); const id = trialJob(db)
    const calls: string[] = []
    // research runs (reserve 0.5) and reports usage that costs $0.95 (300k in + 3,333 out at $3/$15 per M, + 0 searches):
    // the next paid step, grounding, does not fit in the $0.05 left
    const anthropic: Provider = {
      configuredModel: () => 'claude-sonnet-4-5',
      research: async () => { calls.push('research'); return { text: JSON.stringify([lead('https://news.example/a')]), citedUrls: ['https://news.example/a'], usage: { model: 'claude-sonnet-4-5', input_tokens: 300_000, output_tokens: 3_333 } } },
      complete: async () => { calls.push('complete'); return '[]' },
    }
    const out = await runJob(db, claimKeyedJob(db)!, { providers: { anthropic, openai: anthropic }, fetchPage: page, fetchImpl: countFetch, judge: null })
    assert.equal(out, 'done')
    assert.deepEqual(calls, ['research'], 'research ran (not refused up front); the step that did not fit was never sent')
    const job = getJob(db, 'keyless', id)!
    assert.equal(job.status, 'done'); assert.equal(job.error, 'trial_budget_reached')
    const recorded = (db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs WHERE id = ?').get(id) as { s: number }).s
    assert.ok(Math.abs(recorded - 0.95) < 0.001, `research settled to its reported cost (recorded ${recorded})`)
    // the partial result is kept, in the review lane only: nothing reads as verified
    const leads = listLeads(db, 'keyless', id, 200, true) as { company: string; review_reason: string | null }[]
    assert.deepEqual(leads.map(l => [l.company, l.review_reason]), [['Northside Builders', 'trial_budget_reached']])
    const o = scanOutcome({ ...job, id, status: job.status, error: job.error, funded_by: 'trial' } as never)
    assert.equal(o.kind, 'stopped')
    assert.match(o.label, /^Stopped early: this free scan reached its spending limit\. It kept 1 result found before it stopped\.$/)
    assert.match(o.detail ?? '', /review list/)
  })
})

test('a trial scan whose first paid step does not fit stops at once, says so, and is not an empty search', async () => {
  await withEnv({ ...TRIAL_ENV, DAZL_TRIAL_SCAN_RESERVE_USD: '0.3' }, async () => {
    const db = setup(); const id = trialJob(db)
    let researched = false
    const anthropic: Provider = { configuredModel: () => 'claude-sonnet-4-5', research: async () => { researched = true; return { text: '[]', citedUrls: [] } } }
    assert.equal(await runJob(db, claimKeyedJob(db)!, { providers: { anthropic, openai: anthropic }, fetchPage: page, fetchImpl: countFetch, judge: null }), 'done')
    assert.equal(researched, false, 'a $0.50 research reserve does not fit a $0.30 scan: never sent')
    const job = getJob(db, 'keyless', id)!
    assert.deepEqual([job.status, job.error], ['done', 'trial_budget_reached'])
    const o = scanOutcome({ ...job, id, status: job.status, error: job.error, funded_by: 'trial' } as never)
    assert.equal(o.label, 'Stopped early: this free scan reached its spending limit before it found any companies.')
    assert.match(o.detail ?? '', /not an empty search/)
  })
})

test('a trial scan without its caps and prices configured does not run at all', async () => {
  await withEnv({ DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture' }, async () => {
    const db = setup(); const id = trialJob(db)
    let called = false
    const anthropic: Provider = { research: async () => { called = true; return { text: '[]', citedUrls: [] } } }
    assert.equal(await runJob(db, claimKeyedJob(db)!, { providers: { anthropic, openai: anthropic }, fetchPage: page }), 'failed')
    assert.equal(called, false)
    assert.equal(getJob(db, 'keyless', id)!.error, 'trial_unavailable')
  })
})

test('TinyFish: the trial charge runs before each paid search and fetch; a refusal makes no request', async () => {
  const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState()
  const env = { TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '1' }
  let requests = 0
  const fetchImpl = (async () => { requests++; return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as typeof fetch
  const guard = new SpendGuard(0.025); guard.label = 'trial_budget'
  const charge = (kind: 'search' | 'fetch', units: number) => reserveAllUsd([guard], units * (kind === 'search' ? 0.01 : 0.002))
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
