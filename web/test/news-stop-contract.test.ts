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
import { compareActual } from '../lib/scan/price-estimate.ts'
import { readJobCost } from '../lib/scan/status-reads.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { Provider } from '../lib/llm/provider.ts'
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
    for (const [k, v] of c.want.fc) assert.equal((r.failure_classes as Record<string, number>)[k], v, `${c.name}: ${k}`)
    for (const k of ['network', 'http', 'empty_body', 'parse'] as const) if (!c.want.fc.some(([kk]) => kk === k)) assert.equal(r.failure_classes[k], 0, `${c.name}: ${k} stays 0`)
    assert.equal((r.query_classes as Record<string, number>)[c.want.qc[0]], c.want.qc[1], `${c.name}: query class`)
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
  const est = { total: { min: 0.09, max: 0.63 }, rows: [] as { kind: string; usd?: { min: number; max: number } }[] }
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

test('readJobCost returns BOTH reservation columns (the cap reservation was invisible to the cost read)', async () => {
  const raw = new Database(':memory:'); migrateScan(raw)
  const id = createQueryJob(raw, 'A', { query: 'q', icp: JSON.stringify(icp) } as never)
  raw.prepare('UPDATE scan_jobs SET spend_cap_reserved_usd = 0.002214 WHERE id = ?').run(id)
  const db = sqliteDb(raw)
  const j = await readJobCost(db, 'A', id)
  assert.equal(j.reserved_usd, null, 'no max_usd reservation was made')
  assert.equal(j.cap_reserved_usd, 0.002214, 'the cap reservation is read, not dropped')
})
