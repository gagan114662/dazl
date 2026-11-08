// The stop-classification + truthful cost/failure contract (news-stop-contract branch).
// A scan that found no leads must say WHY it stopped: a failed source (source_error), a clean zero from every source it
// was allowed to use (no_discovery), sources that could not conclude with the unpriceable paid fallback held
// (unbounded_fallback_hold), or a real numeric budget refusal (budget_stopped). The UI must never send the user to
// raise a budget when the budget was not the cause, and recorded-but-unsettled usage is never "$0" or "not recorded".
// No network, no paid calls: news failures are injected through deps.newsHttp.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { newsSearch, resetNewsQueue } from '../lib/search/news.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob, newsStatus, refusalCode, fallbackStopCode } from '../lib/scan/runner.ts'
import { SourceRunLedger } from '../lib/scan/source-runs.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { compareActual, type RunEstimate } from '../lib/scan/price-estimate.ts'
import { readJobCost } from '../lib/scan/status-reads.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { ProviderError, type Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const noWait = { gapMs: 0, sleep: async () => {} }
const icp = { summary: 'Dental clinics in Toronto expanding', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['Toronto'], signals: ['opening a new location'], exclude: [], country: 'CA', language: 'en' }

// --- The free news search's bounded, redacted failure classes ------------------------------------------------

test('news failure classes: timeout=network, 429=http+status, empty 200=empty_body, garbage 200=parse, partial kept, clean empty is a real zero', async () => {
  resetNewsQueue()
  const cases: { name: string; http: SafeGet; want: { failed: number; fc: [string, number][]; qc: [string, number]; statuses?: Record<string, number>; hits?: number; malformed?: number } }[] = [
    { name: 'timeout (request throws)', http: async () => { throw new Error('ECONNRESET') }, want: { failed: 1, fc: [['network', 1]], qc: ['failed', 1] } },
    { name: 'HTTP 429', http: async () => ({ status: 429, body: 'slow down' }), want: { failed: 1, fc: [['http', 1]], qc: ['failed', 1], statuses: { '429': 1 } } },
    { name: '200 with no body', http: async () => ({ status: 200, body: '' }), want: { failed: 1, fc: [['empty_body', 1]], qc: ['failed', 1] } },
    { name: '200 with unparseable body', http: async () => ({ status: 200, body: 'not json at all' }), want: { failed: 1, fc: [['parse', 1]], qc: ['failed', 1] } },
    { name: '200 whose every entry is invalid', http: async () => ({ status: 200, body: JSON.stringify({ articles: [{ url: 5, title: 'x' }] }) }), want: { failed: 1, fc: [['parse', 1]], qc: ['failed', 1] } },
    { name: 'valid answer, one invalid entry beside a good one', http: async () => ({ status: 200, body: JSON.stringify({ articles: [{ url: 'https://news.example.com/acme', title: 'Acme expands' }, { url: 5, title: 'x' }] }) }), want: { failed: 0, fc: [], qc: ['ok', 1], hits: 1, malformed: 1 } },
    { name: 'valid answer with nothing in it', http: async () => ({ status: 200, body: '{"articles":[]}' }), want: { failed: 0, fc: [], qc: ['empty', 1], hits: 0 } },
  ]
  for (const c of cases) {
    const r = await newsSearch(c.http, ['q'], 'en', noWait)
    assert.equal(r.failed, c.want.failed, c.name)
    for (const [k, v] of c.want.fc) assert.equal(r.failure_classes[k as keyof typeof r.failure_classes], v, `${c.name}: ${k}`)
    for (const k of ['network', 'http', 'empty_body', 'parse'] as const) if (!c.want.fc.some(([kk]) => kk === k)) assert.equal(r.failure_classes[k], 0, `${c.name}: ${k} stays 0`)
    assert.equal(r.query_classes[c.want.qc[0] as keyof typeof r.query_classes], c.want.qc[1], `${c.name}: query class`)
    if (c.want.statuses) assert.deepEqual(r.http_statuses, c.want.statuses, c.name)
    if (c.want.hits !== undefined) assert.equal(r.hits.length, c.want.hits, c.name)
    if (c.want.malformed !== undefined) assert.equal(r.malformed, c.want.malformed, c.name)
    resetNewsQueue()
  }
  // A 200 rate-limit text is its own class, never an outage or an empty search.
  const r = await newsSearch(async () => ({ status: 200, body: 'Please limit requests to one every 5 seconds' }), ['a'], 'en', noWait)
  assert.equal(r.limited, 1); assert.equal(r.failed, 0); assert.equal(r.query_classes.limited, 1)
  resetNewsQueue()
})

test('newsStatus names a full outage by its failure class (never a bare error when the class is known)', () => {
  const base = { searched: true, hits: 0, attempted: 2, failed: 2 }
  assert.equal(newsStatus(null, base), 'error', 'a note without classes keeps the legacy name')
  assert.equal(newsStatus(null, { ...base, classes: { network: 2, http: 0, empty_body: 0, parse: 0 } }), 'error:network')
  assert.equal(newsStatus(null, { ...base, classes: { network: 0, http: 2, empty_body: 0, parse: 0 } }), 'error:http')
  assert.equal(newsStatus(null, { ...base, classes: { network: 0, http: 0, empty_body: 1, parse: 1 } }), 'error:mixed', 'two classes are named as mixed, not guessed')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 1, failed: 0, classes: { network: 0, http: 0, empty_body: 0, parse: 0 }, query_classes: { ok: 0, empty: 1, limited: 0, failed: 0 } }), 'empty', 'a clean zero stays empty')
})

// --- The stop classification ---------------------------------------------------------------------------------

test('refusalCode: only a real numeric refusal is a budget stop; every other reason keeps its own class', () => {
  const ledger = new SourceRunLedger()
  assert.equal(refusalCode(new SpendRefused('over_limit'), ledger), 'budget_stopped')
  assert.equal(refusalCode(new SpendRefused('over_cap'), ledger), 'budget_stopped')
  assert.equal(refusalCode(new SpendRefused('owner_pool_limit'), ledger), 'budget_stopped', 'the shared pool refusal is a numeric limit stop - with its OWN typed reason')
  assert.equal(refusalCode(new SpendRefused('trial_budget_reached'), ledger), 'budget_stopped')
  assert.equal(refusalCode(new SpendRefused('research_unbounded'), ledger), 'unbounded_fallback_hold')
  assert.equal(refusalCode(new SpendRefused('model_unpriced'), ledger), 'model_unpriced')
  assert.equal(refusalCode(new SpendRefused('count_failed'), ledger), 'spend_count_failed')
  for (const r of ['accounting_uncertain', 'accounting_unsettled', 'reservation_not_saved', 'reservation_invalid', 'ledger_unavailable', 'busy'])
    assert.equal(refusalCode(new SpendRefused(r), ledger), 'spend_accounting_unavailable', r)
  for (const r of ['units_invalid', 'price_invalid', 'price_unknown', 'cost_invalid', 'cap_config_invalid', 'kind_unknown'])
    assert.equal(refusalCode(new SpendRefused(r), ledger), 'spend_config_invalid', r)
  for (const r of ['ownership_lost', 'scan_not_found', 'scan_not_active']) assert.equal(refusalCode(new SpendRefused(r), ledger), 'ownership_lost', r)
  assert.equal(refusalCode(new SpendRefused('some_future_reason'), ledger), 'spend_refused', 'an unknown reason is named, never silently a budget stop')
})

test('fallbackStopCode reads the source rows: failed source / clean zero / could-not-conclude', () => {
  const ledger = new SourceRunLedger()
  ledger.record('search:news', 'error:network')
  assert.equal(fallbackStopCode(ledger), 'source_error')
  assert.equal(refusalCode(new SpendRefused('research_unbounded'), ledger), 'source_error', 'the QA shape: News ERROR then the unbounded fallback refusal is a source error, never a budget stop')
  const clean = new SourceRunLedger()
  clean.record('search:news', 'empty')
  assert.equal(fallbackStopCode(clean), 'no_discovery')
  const cleanTf = new SourceRunLedger()
  cleanTf.record('search:tinyfish', 'empty')
  assert.equal(fallbackStopCode(cleanTf), 'no_discovery')
  const held = new SourceRunLedger()
  held.record('search:news', 'unavailable')
  assert.equal(fallbackStopCode(held), 'unbounded_fallback_hold')
  const limited = new SourceRunLedger()
  limited.record('search:news', 'limited')
  assert.equal(fallbackStopCode(limited), 'source_error', 'a throttled source is a failed source, not a clean zero')
})

// The QA shape end to end: an injected News failure with the paid fallback disabled must stop as source_error (the
// pre-fix code labelled this budget_stopped and the UI told the user to raise a budget that could not fix it).
async function newsStopRun(http: SafeGet) {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  const id = createQueryJob(db, 'A', { query: 'Dental clinics in Toronto opening a new location', icp: JSON.stringify(icp) } as never)
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '[]', citedUrls: [] }),
      complete: async (_k, p) => p.startsWith('Write up to') ? '["dental clinic Toronto"]' : '[]',
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const r = await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: async () => ({ text: 'x'.repeat(300), title: 't', retrievedAt: 1 }), newsHttp: http, paidFallback: false, judge: null, score: false })
  const job = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string }
  const news = db.prepare("SELECT status FROM scan_source_runs WHERE job_id = ? AND collector = 'search:news'").get(id) as { status: string } | undefined
  const reportRow = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string } | undefined
  const report = reportRow ? JSON.parse(reportRow.report) as { news: { failure_classes: Record<string, number>; query_classes: Record<string, number>; http_statuses: Record<string, number>; attempted: number } | null; stop: { code: string; spend_refusal_reason: string | null } | null } : null
  return { r, job, news, report }
}

test('injected News network failure + fallback disabled: source_error, classed source row, typed report - never budget_stopped', async () => {
  resetNewsQueue()
  const { r, job, news, report } = await newsStopRun(async () => { throw new Error('ECONNRESET') })
  assert.equal(r, 'failed')
  assert.equal(job.error, 'source_error', 'a failed source is never a budget stop')
  assert.equal(news?.status, 'error:network', 'the persisted News row names its failure class')
  assert.ok(report, 'a run report exists')
  assert.equal(report!.news?.failure_classes?.network, 1, 'the report carries the bounded failure class')
  assert.equal(report!.news?.attempted, 1)
  assert.equal(report!.news?.query_classes?.failed, 1)
  assert.deepEqual(report!.stop, { code: 'source_error', spend_refusal_reason: null }, 'the stop block names the code and that no spend refusal caused it')
  resetNewsQueue()
})

test('clean-empty News + fallback disabled: no_discovery (searched-and-found-nothing, coverage limited), never budget_stopped', async () => {
  resetNewsQueue()
  const { r, job, news, report } = await newsStopRun(async () => ({ status: 200, body: '{"articles":[]}' }))
  assert.equal(r, 'failed')
  assert.equal(job.error, 'no_discovery')
  assert.equal(news?.status, 'empty', 'the News row records a real zero-result search')
  assert.equal(report!.news?.query_classes?.empty, 1)
  assert.equal(report!.news?.failure_classes?.network ?? 0, 0, 'no failures on a clean zero')
  assert.deepEqual(report!.stop, { code: 'no_discovery', spend_refusal_reason: null })
  resetNewsQueue()
})

// --- Truthful cost: recorded usage is never "not recorded", unsettled USD is never $0, a reservation is not a charge ---

test('compareActual: recorded calls with unsettled USD are stated truthfully; the cap reservation is named as a reservation', () => {
  const est: Pick<RunEstimate, 'total' | 'rows'> = { total: { min: 0.09, max: 0.63 }, rows: [] }
  // The QA shape: 1 call, 368 in / 74 out tokens reported, but no priced model -> USD unknown.
  const a = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-future-unlisted', searches: null, reservedUsd: null, requests: 1, requestsWithTokens: 1, capReservedUsd: 0.002214 })
  assert.equal(a.model_usd, null, 'no fabricated USD')
  assert.equal(a.within, 'unknown')
  assert.match(a.summary, /1 model call recorded/)
  assert.match(a.summary, /368 input \/ 74 output tokens/)
  assert.match(a.summary, /no listed price/)
  assert.match(a.summary, /unknown, not \$0/, 'unsettled is unknown, never free')
  assert.match(a.summary, /Reserved under this run's spend cap: \$0\.0022 \(a reservation, not a settled charge\)/, 'the reservation is named as itself')
  assert.equal(a.cap_reserved_usd, 0.002214)
  // Calls recorded but the provider reported no tokens at all.
  const b = compareActual(est, { inputTokens: null, outputTokens: null, tokensComplete: false, model: null, searches: null, reservedUsd: null, requests: 2, requestsWithTokens: 0 })
  assert.match(b.summary, /2 model calls recorded/)
  assert.match(b.summary, /no token usage/)
  assert.match(b.summary, /unknown - not \$0/)
  // Nothing recorded at all keeps the old honest "not recorded".
  const c = compareActual(est, { inputTokens: null, outputTokens: null, tokensComplete: false, model: null, searches: null, reservedUsd: null, requests: 0, requestsWithTokens: 0 })
  assert.match(c.summary, /was not recorded/)
  // A priced call is unchanged.
  const d = compareActual(est, { inputTokens: 1000, outputTokens: 100, tokensComplete: true, model: 'claude-sonnet-4-5', searches: 3, reservedUsd: null, requests: 1, requestsWithTokens: 1 })
  assert.ok(d.model_usd !== null && d.model_usd > 0)
  assert.match(d.summary, /from the tokens the provider reported/)
})

// --- Legacy budget_stopped renders neutrally; only typed provenance names a numeric control ----------------------
test('scanOutcome: a legacy budget_stopped (no recorded reason) never claims a budget cause; typed numeric reasons keep the specific copy', async () => {
  const { scanOutcome } = await import('../lib/scan/scan-outcome.ts')
  const base = { id: 'x'.repeat(24), status: 'failed', error: 'budget_stopped', created_at: 1, finished_at: 2, candidates: 0, verified: 0, needs_review: 0, dropped: 0, lead_count: 0 }
  const legacy = scanOutcome({ ...base, stop_refusal_reason: null })
  assert.equal(legacy.kind, 'stopped')
  assert.equal(legacy.label, 'Stopped before it could conclude')
  assert.match(legacy.detail ?? '', /exact reason was not kept/)
  assert.doesNotMatch(`${legacy.label} ${legacy.detail} ${legacy.next?.text}`, /larger budget|without.*budget|per-run budget refused/i, 'no budget cause claim, no budget-change advice')
  const missing = scanOutcome({ ...base }) // legacy row: the field is absent entirely
  assert.equal(missing.label, 'Stopped before it could conclude')
  const overLimit = scanOutcome({ ...base, stop_refusal_reason: 'over_limit' })
  assert.equal(overLimit.label, 'Stopped by its budget - not an empty search')
  assert.equal(overLimit.next?.text, 'Run it again with a larger budget')
  const overCap = scanOutcome({ ...base, stop_refusal_reason: 'over_cap' })
  assert.equal(overCap.label, 'Stopped by its budget - not an empty search')
  const pool = scanOutcome({ ...base, stop_refusal_reason: 'owner_pool_limit' })
  assert.equal(pool.label, 'Stopped by the shared account spending limit - not an empty search')
  assert.match(pool.detail ?? '', /day\/month spending limit/)
  assert.doesNotMatch(`${pool.label} ${pool.detail} ${pool.next?.text}`, /larger budget|raising or removing the (per-scan )?budget would|without.*budget/i, 'the pool stop never advises touching the per-scan budget')
  assert.match(pool.detail ?? '', /raising or removing it would not have searched further/)
  const trial = scanOutcome({ ...base, stop_refusal_reason: 'trial_budget_reached' })
  assert.equal(trial.label, 'This free scan found no companies within its spending limit')
  const unknownReason = scanOutcome({ ...base, stop_refusal_reason: 'something_not_numeric' })
  assert.equal(unknownReason.label, 'Stopped before it could conclude', 'an unrecorded-shape reason is never read as a budget cause')
})

// --- The combined branch: an earlier SpendRefused + paid fallback disabled -------------------------------------
// Reviewer repro (own-news-refusal): the TinyFish path's spend refusal used to end as budget_stopped for ANY reason.
// Only a real numeric refusal is a budget stop on this branch too; every other reason keeps its own class end to end.
async function earlierRefusalRun(budgetJson: string, model: string, countMode: 'ok' | 'huge' | 'fail' = 'ok') {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  const id = createQueryJob(db, 'A', { query: 'Toronto dental clinics expanding', icp: JSON.stringify(icp) } as never)
  db.prepare('UPDATE scan_jobs SET run_budget = ?').run(budgetJson)
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://news.example.test/a', title: 'Dental expansion', snippet: 'Dental clinic expands in Toronto' }] }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://news.example.test/a', title: 'Dental expansion', text: 'Dental clinic expands in Toronto.' }] }), { status: 200 })
    if (u === 'https://api.anthropic.com/v1/messages/count_tokens') {
      if (countMode === 'fail') return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ input_tokens: countMode === 'huge' ? 5_000_000 : 1000 }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => { throw new Error('the paid fallback is disabled: research must not run') }, complete: async () => '[]', configuredModel: () => model },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  process.env.TINYFISH_API_KEY = 'tf-test'
  try {
    const r = await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, score: false, judge: null, fetchImpl, paidFallback: false })
    const job = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string }
    const tf = db.prepare("SELECT status FROM scan_source_runs WHERE job_id = ? AND collector = 'search:tinyfish'").get(id) as { status: string } | undefined
    const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string } | undefined
    const stop = row ? (JSON.parse(row.report) as { stop: { code: string; spend_refusal_reason: string | null; superseded_stop_code?: string | null } | null }).stop : null
    return { r, job, tf, stop }
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
}

test('earlier refusal + fallback disabled: every non-numeric reason keeps its class; only a numeric refusal is a budget stop', async () => {
  // The reviewer's exact repro: the guard's count_tokens preflight fails -> count_failed. Never a budget stop.
  const c = await earlierRefusalRun('{"max_usd":5,"paid_fallback":false}', 'claude-sonnet-4-5', 'fail')
  assert.equal(c.job.error, 'spend_count_failed')
  assert.equal(c.tf?.status, 'partial_hold:count_failed', 'the source row keeps the exact refusal reason')
  assert.deepEqual(c.stop, { code: 'spend_count_failed', spend_refusal_reason: 'count_failed' }, 'report and job agree, reason kept')
  // An unpriced model refuses at ANY budget.
  const m = await earlierRefusalRun('{"max_usd":5,"paid_fallback":false}', 'unpriced-review-model')
  assert.equal(m.job.error, 'model_unpriced')
  assert.equal(m.stop?.code, 'model_unpriced')
  assert.equal(m.stop?.spend_refusal_reason, 'model_unpriced')
  // The numeric controls: a budget too small for the first paid call, and an estimate over the budget, stay budget_stopped.
  const small = await earlierRefusalRun('{"max_usd":0.0001,"paid_fallback":false}', 'claude-sonnet-4-5')
  assert.equal(small.job.error, 'budget_stopped', 'a real numeric refusal is still a budget stop')
  assert.equal(small.stop?.spend_refusal_reason, 'over_limit')
  const huge = await earlierRefusalRun('{"max_usd":5,"paid_fallback":false}', 'claude-sonnet-4-5', 'huge')
  assert.equal(huge.job.error, 'budget_stopped', 'a real estimate over the numeric budget is still a budget stop')
  assert.equal(huge.stop?.spend_refusal_reason, 'over_limit')
})

// --- The free search's request truth survives a later failure --------------------------------------------------
// Reviewer repro (own-news-diagnostic-loss): a SpendRefused from the extraction step rethrew before the note was
// staged, dropping the already-recorded query truth (report.news null despite a searched, successful query).
test('a refusal AFTER the free search ran still persists the bounded news note (counts/statuses, never payloads)', async () => {
  resetNewsQueue()
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  const id = createQueryJob(db, 'A', { query: 'Toronto dental clinics expanding', icp: JSON.stringify(icp) } as never)
  let calls = 0
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { throw new Error('must not run') },
      complete: async () => { calls++; if (calls === 1) return '["dental Toronto"]'; throw new SpendRefused('count_failed') },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const r = await runJob(db, claimKeyedJob(db, id)!, {
    providers: prov, master, score: false, judge: null,
    newsHttp: async () => ({ status: 200, body: JSON.stringify({ articles: [{ url: 'https://news.example.test/a', title: 'Dental expansion' }] }) }),
    fetchPage: async () => ({ text: 'Dental clinic is opening a Toronto office. '.repeat(20), title: 'Expansion', retrievedAt: 1 }),
  })
  assert.equal(r, 'failed')
  const job = db.prepare('SELECT error FROM scan_jobs WHERE id = ?').get(id) as { error: string }
  assert.equal(job.error, 'spend_count_failed', 'the refusal keeps its own class')
  const news = db.prepare("SELECT status FROM scan_source_runs WHERE job_id = ? AND collector = 'search:news'").get(id) as { status: string }
  assert.match(news.status, /^partial_hold:count_failed/, 'the source row names the hold-stopped partial with its reason')
  const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string }
  const report = JSON.parse(row.report) as { news: { attempted: number; query_classes: Record<string, number> } | null; stop: { code: string; spend_refusal_reason: string | null } }
  assert.ok(report.news, 'the searched query truth is NOT dropped by the later refusal')
  assert.equal(report.news!.attempted, 1)
  assert.equal(report.news!.query_classes.ok, 1)
  assert.equal(report.stop.code, 'spend_count_failed')
  assert.equal(report.stop.spend_refusal_reason, 'count_failed')
  resetNewsQueue()
})

// --- Terminal truth: finish()'s authoritative overrides reconcile the staged stop block ------------------------
// Reviewer repro (own-news-report): an uncertain (maybe-billed) extraction failure with the fallback held ended the
// job accounting_uncertain while report.stop still said source_error. stop.code must be the FINAL job error.
test('an uncertain paid failure overrides the staged stop: report.stop carries the final code AND the superseded one', async () => {
  resetNewsQueue()
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  const id = createQueryJob(db, 'A', { query: 'Toronto dental clinics expanding', icp: JSON.stringify(icp), runBudget: '{"paid_fallback":false}' } as never)
  let calls = 0
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { throw new Error('must not run') },
      complete: async () => { calls++; if (calls === 1) return '["dental Toronto"]'; throw new ProviderError('retry', 'network_or_timeout', 'uncertain') },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const r = await runJob(db, claimKeyedJob(db, id)!, {
    providers: prov, master, score: false, judge: null,
    newsHttp: async () => ({ status: 200, body: JSON.stringify({ articles: [{ url: 'https://news.example.test/a', title: 'Dental expansion' }] }) }),
    fetchPage: async () => ({ text: 'Dental clinic is opening a Toronto office. '.repeat(20), title: 'Expansion', retrievedAt: 1 }),
  })
  assert.equal(r, 'failed')
  const job = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string }
  assert.equal(job.error, 'accounting_uncertain', 'a maybe-billed call ends the run accounting_uncertain')
  const row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(id) as { report: string }
  const stop = (JSON.parse(row.report) as { stop: { code: string; spend_refusal_reason: string | null; superseded_stop_code?: string | null } }).stop
  assert.equal(stop.code, 'accounting_uncertain', 'stop.code is the code written as the job error')
  assert.equal(stop.superseded_stop_code, 'source_error', 'the staged classification is preserved, not lost')
  assert.equal(stop.spend_refusal_reason, null, 'no spend refusal happened; nothing invented')
  const news = db.prepare("SELECT status FROM scan_source_runs WHERE job_id = ? AND collector = 'search:news'").get(id) as { status: string }
  assert.equal(news.status, 'error:model_retry', 'the source row names the failed stage independently')
  resetNewsQueue()
})

// --- Canonical cost truth: dated served ids price via the settlement normalization -----------------------------
test('compareActual: a dated KNOWN served model prices (the QA token shape settles to $0.002214), genuinely-unlisted and mixed models stay honestly unknown, cache tokens price at the shared factors', () => {
  const modelRow: RunEstimate['rows'][number] = { id: 'model', label: 'Model', provider: 'anthropic', kind: 'model', unit: '1M input tokens', unit_usd: '$3.00 in / $15.00 out per 1M tokens', units: { min: 0, max: 1 }, usd: { min: 0, max: 0.01 }, capped: true, note: '' }
  const est: Pick<RunEstimate, 'total' | 'rows'> = { total: { min: 0.001, max: 0.01 }, rows: [modelRow] }
  // Dated known id: the settlement path's priceOf strips the -YYYYMMDD suffix; an exact-map lookup lied "no listed price".
  const dated = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', searches: 0, reservedUsd: null, requests: 1, requestsWithTokens: 1, capReservedUsd: 0.002214 })
  assert.equal(dated.model_usd, 0.002214, '368in/74out at the sonnet price')
  assert.match(dated.summary, /from the tokens the provider reported/)
  assert.doesNotMatch(dated.summary, /no listed price/, 'a priced dated model is never reported unpriced')
  // Cache usage is not stored, so $0.002214 is the recorded-token component: at-least, not complete, no range claim.
  assert.equal(dated.model_usd_complete, false)
  assert.equal(dated.within, 'unknown')
  assert.match(dated.summary, /at least \$0\.0022/)
  assert.match(dated.summary, /cache token usage was not recorded, so this is the recorded-token component, not the full cost/)
  assert.match(dated.summary, /a reservation, not a settled charge/, 'the reservation is still named as itself, never folded into the cost')
  // Genuinely unlisted model: honestly unknown with the real reason.
  const unlisted = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-future-unlisted', searches: 0, reservedUsd: null, requests: 1, requestsWithTokens: 1 })
  assert.equal(unlisted.model_usd, null)
  assert.match(unlisted.summary, /no listed price/)
  assert.match(unlisted.summary, /unknown, not \$0/)
  // Mixed served models with different prices: the stored sums cannot be priced as one total - never fabricated.
  const mixed = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', servedModels: ['claude-sonnet-4-5-20250929', 'claude-opus-4-1'], searches: 0, reservedUsd: null, requests: 2, requestsWithTokens: 2 })
  assert.equal(mixed.model_usd, null)
  assert.match(mixed.summary, /more than one served model/)
  assert.match(mixed.summary, /not \$0/)
  // Mixed ids that normalize to the SAME price entry price fine (dated + undated sonnet) - still the recorded-token
  // component while cache usage is unrecorded.
  const samePrice = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', servedModels: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'], searches: 0, reservedUsd: null, requests: 2, requestsWithTokens: 2 })
  assert.equal(samePrice.model_usd, 0.002214)
  assert.equal(samePrice.model_usd_complete, false)
  assert.equal(samePrice.within, 'unknown')
  // Explicit cache zeros are a real record: complete, placed in the range, no at-least wording.
  const knownZero = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', searches: 0, reservedUsd: null, requests: 1, requestsWithTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 })
  assert.equal(knownZero.model_usd, 0.002214)
  assert.equal(knownZero.model_usd_complete, true)
  assert.equal(knownZero.within, 'within')
  assert.match(knownZero.summary, /^Actual model cost \$0\.0022 from/)
  // Cache tokens at the shared factors (writes 2x, reads 0.1x the input price) via the same completionCost the settlement uses.
  const cached = compareActual(est, { inputTokens: 368, outputTokens: 74, tokensComplete: true, model: 'claude-sonnet-4-5-20250929', searches: 0, reservedUsd: null, requests: 1, requestsWithTokens: 1, cacheWriteTokens: 1000, cacheReadTokens: 2000 })
  assert.equal(cached.model_usd, (368 * 3 + 74 * 15 + 1000 * 3 * 2 + 2000 * 3 * 0.1) / 1e6)
  assert.equal(cached.model_usd_complete, true)
})

test('readJobCost returns BOTH reservation columns (the cap reservation was invisible to the cost read)', async () => {
  const raw = new Database(':memory:'); migrateScan(raw)
  const id = createQueryJob(raw, 'A', { query: 'q', icp: JSON.stringify(icp) } as never)
  raw.prepare('UPDATE scan_jobs SET spend_cap_reserved_usd = 0.002214 WHERE id = ?').run(id)
  const db = sqliteDb(raw)
  const j = await readJobCost(db, 'A', id)
  assert.equal(j.reserved_usd, null, 'no max_usd reservation was made')
  assert.equal(j.cap_reserved_usd, 0.002214, 'the cap reservation is read, not dropped')
})

// The reviewer's 03:04 repro corrected end to end: the shared pool's refusal carries its OWN typed reason through the
// real PooledGuard.reserveShared, so report provenance can never read a pool stop as the per-run budget's refusal.
test('PooledGuard: a shared-pool refusal reports owner_pool_limit, never over_limit', async () => {
  const { PooledGuard, SpendRefused } = await import('../lib/llm/spend-guard.ts')
  const { OWNER_POOL_LIMIT_REASON } = await import('../lib/llm/spend-pool.ts')
  const pool = { now: () => 1000, reserve: async () => { throw new SpendRefused('over_limit') } }
  const g = new PooledGuard(pool as never)
  g.label = OWNER_POOL_LIMIT_REASON   // what runner.ts sets at construction
  await assert.rejects(g.reserveShared(0.01), (e: unknown) => (e as InstanceType<typeof SpendRefused>).reason === 'owner_pool_limit')
  assert.equal(refusalCode(new SpendRefused('owner_pool_limit')), 'budget_stopped')
})
