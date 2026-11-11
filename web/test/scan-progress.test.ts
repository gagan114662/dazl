// A scan ends in exactly one of four honest ways, and a running scan shows per-source progress as data the UX can poll. Stubbed sources and pages, invented companies, no network.
//   failed (which source) | rejected (counts per reason) | zero-match (the sources returned nothing) | yielded N leads
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import type Database from 'better-sqlite3'
import { progressOf, outcomeInputs, sourceStatusOf, partialNote } from '../lib/scan/progress.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { newsSearch, resetNewsQueue } from '../lib/search/news.ts'
import { newsStatus } from '../lib/scan/runner.ts'
import { runReportFor } from '../lib/scan/run-report.ts'

const done = (o: object) => scanOutcome({ id: 'j1', status: 'done', error: null, ...o })
const failed = (error: string | null, o: object = {}) => scanOutcome({ id: 'j1', status: 'failed', error, ...o })

test('pure: the four endings are distinct and each says what it knows', () => {
  // failed, naming the source
  const f = failed('provider exploded', { failed_sources: ['search:tinyfish'] }); assert.equal(f.kind, 'failed'); assert.match(f.label, /^Failed - search:tinyfish had an error/)
  // an empty result with a failed source is NOT zero-match
  assert.equal(failed('no_candidates', { failed_sources: ['search:tinyfish'], search_hits: 0 }).kind, 'failed')
  // zero-match: the search recorded zero results and nothing failed
  const z = failed('no_candidates', { search_hits: 0, failed_sources: [] }); assert.equal(z.kind, 'zero_match'); assert.match(z.label, /^Zero match - the sources returned nothing/)
  assert.equal(failed('no_candidates', { search_hits: null }).kind, 'none_extracted', 'unrecorded hits: not claimed as zero-match')
  assert.equal(failed('no_candidates', { search_hits: 12 }).kind, 'none_extracted', 'results existed but nothing was extracted: not zero-match')
  // rejected, with counts per reason
  const r = done({ candidates: 7, verified: 0, needs_review: 0, dropped: 7, reject_reasons: { 'dropped:excerpt_not_on_page': 4, 'dropped:duplicate': 3 } })
  assert.equal(r.kind, 'all_dropped'); assert.equal(r.label, '7 found, all dropped by the checks'); assert.equal(r.detail, 'Rejected: excerpt not on page x4, duplicate x3.')
  // yielded N leads
  const y = done({ candidates: 5, verified: 2, needs_review: 1, dropped: 2 }); assert.equal(y.kind, 'leads'); assert.match(y.label, /^5 found: 2 source-checked, 1 needs your review, 2 dropped/)
  assert.equal(new Set([f.kind, z.kind, r.kind, y.kind]).size, 4)
})

test('pure: per-source progress — status, candidates found, accepted; unknown stays null; a source that never reported is failed once the scan is over', () => {
  const rows = [
    { collector: 'search:tinyfish', status: 'ok', evidence_count: 9, candidate_count: 4, verified_count: 2, review_count: 1 },
    { collector: 'search:news', status: 'started', evidence_count: null, candidate_count: null, verified_count: null, review_count: null },
    { collector: 'adapter:jobboards', status: 'skipped_no_hiring_signal', evidence_count: null, candidate_count: null, verified_count: null, review_count: null },
    { collector: 'advanced:x', status: 'unavailable', evidence_count: null, candidate_count: null, verified_count: null, review_count: null },
    { collector: 'search:anthropic', status: 'empty', evidence_count: 0, candidate_count: 0, verified_count: 0, review_count: 0 },
  ]
  const live = progressOf(rows, 'running'); const by = (p: ReturnType<typeof progressOf>, s: string) => p.find(x => x.source === s)!
  assert.deepEqual(by(live, 'search:tinyfish'), { source: 'search:tinyfish', state: 'done', status: 'ok', note: null, candidates: 4, accepted: 2, review: 1, rejected: 1 })
  assert.deepEqual(by(live, 'search:news'), { source: 'search:news', state: 'running', status: 'running', note: null, candidates: null, accepted: null, review: null, rejected: null })
  assert.equal(by(live, 'adapter:jobboards').status, 'skipped'); assert.equal(by(live, 'advanced:x').status, 'unavailable', 'no data from it is not proof that it failed'); assert.equal(by(live, 'search:anthropic').status, 'empty')
  assert.equal(by(progressOf(rows, 'done'), 'search:news').status, 'failed', 'started but never reported, and the scan is over')
  assert.equal(sourceStatusOf('started', true), 'running')
  assert.deepEqual(outcomeInputs(null, rows, 'done').failed_sources, ['search:news'], 'only a source that never reported is failed; unavailable is not')
  // a source the spend hold refused BEFORE it ran (skipped_hold) is skipped, never "had an error"
  assert.equal(sourceStatusOf('skipped_hold', false), 'skipped')
  assert.deepEqual(outcomeInputs(null, [{ collector: 'search:anthropic', status: 'skipped_hold' }], 'failed').failed_sources, [])
  assert.deepEqual(progressOf([{ collector: 'search:x', status: 'error', evidence_count: null, candidate_count: null, verified_count: null, review_count: null }], 'done')[0].status, 'failed')
  assert.deepEqual(outcomeInputs({ funnel: { review_reasons: { quote_unconfirmed: 2 }, drop_reasons: { duplicate: 1 } }, search: { hits_unique_urls: 6, attempted: 3, ok: 3 } }, [], 'done'), { failed_sources: [], reject_reasons: { 'review:quote_unconfirmed': 2, 'dropped:duplicate': 1 }, search_hits: 6, evidence_sources: [], unknown_sources: [], partial_sources: [], stop_refusal_reason: null })
  assert.deepEqual(outcomeInputs({ search: { attempted: 3, ok: 0, hits_unique_urls: 0 } }, [], 'done').failed_sources, ['search:tinyfish'], 'every search attempt failed: a failed source, not an empty result')
})

// ---- through the real runJob (stubbed search, pages and extraction) ----
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const page = { title: 'Brightloop raises seed round', text: `On ${daysAgo(12)}, ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
const base = (over: Partial<Fixture> = {}): Fixture => ({
  request: REQUEST, modelIcp: ICP, modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
  extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: QUOTE, event_date: daysAgo(12) }], ...over,
})
async function ending(f: Fixture) {
  const r = await runFixture(f)
  const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const rows = sourceRuns(r.db, 'A', jobId) as Record<string, unknown>[]
  const rep = (runReportFor(r.db, 'A', jobId) ?? []).at(-1) ?? null
  const job = r.db.prepare('SELECT id, status, error, candidates, verified, needs_review, dropped FROM scan_jobs').get() as Record<string, unknown>
  return { r, rows, progress: progressOf(rows, String(job.status)), outcome: scanOutcome({ ...job, ...outcomeInputs(rep, rows, String(job.status)) } as never), job }
}

test('runJob: YIELDED — a verified lead; the search source shows ok with the candidate accepted', async () => {
  const e = await ending(base())
  assert.equal(e.outcome.kind, 'leads', JSON.stringify(e.outcome)); const s = e.progress.find(p => p.source === 'search:tinyfish')!
  assert.deepEqual([s.status, s.candidates, s.accepted], ['ok', 1, 1])
})

test('runJob: REJECTED — candidates were found but every one failed a gate; the counts per reason are reported', async () => {
  const e = await ending(base({ extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: 'Brightloop quietly closed a 3m GBP round this month and said nothing else', event_date: daysAgo(12) }] }))
  assert.ok(['all_dropped', 'review_only'].includes(e.outcome.kind), JSON.stringify(e.outcome))
  const reasons = outcomeInputs((runReportFor(e.r.db, 'A', String((e.job as { id: string }).id)) ?? []).at(-1), e.rows, 'done').reject_reasons
  assert.ok(reasons && Object.values(reasons).reduce((a, b) => a + b, 0) >= 1, `a reason is counted: ${JSON.stringify(reasons)}`)
  if (e.outcome.kind === 'all_dropped') assert.match(e.outcome.detail ?? '', /^Rejected: .* x\d/)
  assert.equal(e.progress.find(p => p.source === 'search:tinyfish')!.accepted, 0)
})

test('runJob: ZERO-MATCH — the search returned nothing and no source failed', async () => {
  const e = await ending(base({ hits: [], tfPages: {}, own: {}, extraction: [] }))
  assert.equal(e.outcome.kind, 'zero_match', JSON.stringify([e.outcome, e.job, e.rows]))
  assert.match(e.outcome.label, /sources returned nothing/)
})

// A maybe-billed (5xx / timeout) TinyFish call keeps the fail-closed rule ONLY when the call is priced: a free ($0) failed call is one failed page
// (#848, owner-approved 2026-11-11; tinyfish-free-failure.test.ts). These tests pin the priced path, so they set a TinyFish price like the cap tests below.
function ptest(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD = '0.001'; process.env.DAZL_SCAN_PRICE_TINYFISH_FETCH_USD = '0.001'
    try { await fn() } finally { delete process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD; delete process.env.DAZL_SCAN_PRICE_TINYFISH_FETCH_USD }
  })
}

ptest('runJob: FAILED — the search source answers 500: the outcome names the source, says a paid step may have been billed, and is not "zero-match"', async () => {
  const e = await ending(base({ hits: [], tfPages: {}, own: {}, extraction: [], searchStatus: 500 }))
  assert.equal(e.outcome.kind, 'failed', JSON.stringify([e.outcome, e.job, e.rows]))
  // Provenance: ONLY the source whose own request errored is named. The model search was refused BEFORE it ran (the spend
  // hold), so its row reads skipped_hold and it is never reported as "had an error".
  assert.equal(e.outcome.label, 'Failed - search:tinyfish had an error; a paid step may already have been billed')
  const rep = (runReportFor(e.r.db, 'A', String((e.job as { id: string }).id)) ?? []).at(-1) ?? null
  assert.deepEqual(outcomeInputs(rep, e.rows, String(e.job.status)).failed_sources, ['search:tinyfish'])
  assert.equal((e.rows.find(r => r.collector === 'search:anthropic') as { status?: string } | undefined)?.status, 'skipped_hold')
  // The source whose own request was sent and failed is named failed: its row is 'error', never flipped to skipped_hold by the finish-time hold.
  assert.equal((e.rows.find(r => r.collector === 'search:tinyfish') as { status?: string } | undefined)?.status, 'error')
  // #594: a 5xx after send may have been billed, so the job error is accounting_uncertain and the outcome says so while still naming the source.
  assert.equal(e.job.error, 'accounting_uncertain'); assert.match(e.outcome.detail ?? '', /dazl did not run it again automatically: that could bill the same step twice/); assert.doesNotMatch(`${e.outcome.label} ${e.outcome.detail}`, /zero|no compan|nothing matches|sources returned nothing/i)
  assert.notEqual(e.outcome.kind, 'zero_match')
})

test('runJob: FAILED — the model search itself answers 500 after send: anthropic is named, never "skipped", billing uncertainty stated', async () => {
  const e = await ending(base({ hits: [], tfPages: {}, own: {}, extraction: [], researchError: true, tinyfishOff: true }))
  assert.equal(e.outcome.kind, 'failed', JSON.stringify([e.outcome, e.job, e.rows]))
  assert.equal(e.outcome.label, 'Failed - search:anthropic had an error; a paid step may already have been billed')
  assert.equal((e.rows.find(r => r.collector === 'search:anthropic') as { status?: string } | undefined)?.status, 'error')
  assert.equal(e.job.error, 'accounting_uncertain')
  const rep = (runReportFor(e.r.db, 'A', String((e.job as { id: string }).id)) ?? []).at(-1) ?? null
  assert.deepEqual(outcomeInputs(rep, e.rows, String(e.job.status)).failed_sources, ['search:anthropic'])
})

ptest('runJob: FAILED — a search fails after partial hits: the source reads error and keeps its partial evidence, never "ok"', async () => {
  const hit = { url: 'https://ex.com/x', title: 'X', snippet: 's', date: null }
  const e = await ending(base({
    hits: [], modelQueries: ['London SaaS seed round', 'London SaaS startup funding'],
    hitsFor: (n: number) => n === 0 ? [hit] : [],
    searchStatusFor: (n: number) => n === 1 ? 500 : undefined,
    tfPages: { 'https://ex.com/x': { title: 'X', text: 'evidence text' } },
    own: {}, extraction: [{ company: 'X Co', signal: 's', source_url: 'https://ex.com/x', excerpt: 'e', event_date: null }],
  }))
  assert.equal(e.job.error, 'accounting_uncertain', JSON.stringify([e.outcome, e.job, e.rows]))
  const row = e.rows.find(r => r.collector === 'search:tinyfish') as { status?: string } | undefined
  // A sent-and-failed search after a partial hit is a real vendor error - never 'ok' on partial results. The fetch/extract
  // stages after it were refused by the spend hold, so no candidates are claimed; the attempted hits stay in the run report.
  assert.equal(row?.status, 'error')
  assert.equal((e.rows.find(r => r.collector === 'search:anthropic') as { status?: string } | undefined)?.status, 'skipped_hold', 'the later model search was refused before it ran')
  assert.equal(e.outcome.kind, 'failed')
  assert.match(e.outcome.label, /search:tinyfish had an error/)
  // The partial work is RETAINED as evidence in the run report (verified by direct table probe): 2 searches attempted, 1 ok, the partial hit counted.
  assert.equal(e.r.report!.search.attempted, 2, JSON.stringify(e.r.report!.search))
  assert.equal(e.r.report!.search.ok, 1)
  assert.equal(e.r.report!.search.hits_unique_urls, 1, 'the partial hit is not lost')
  // PERSISTED evidence, not only the in-memory result: the scan_run_report and scan_source_stats ROWS are written for the failed path.
  const jobId = String((e.job as { id: string }).id)
  const repRow = e.r.db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(jobId) as { report: string } | undefined
  assert.ok(repRow, 'the scan_run_report row is persisted for the failed partial run')
  const repJson = JSON.parse(repRow!.report) as { search: { attempted: number; ok: number; hits_unique_urls: number } }
  assert.equal(repJson.search.attempted, 2, 'persisted report: both searches recorded')
  assert.equal(repJson.search.ok, 1, 'persisted report: the successful search recorded')
  assert.equal(repJson.search.hits_unique_urls, 1, 'persisted report: the partial hit is not lost')
  const statsRow = e.r.db.prepare("SELECT searches_attempted, searches_ok FROM scan_source_stats WHERE job_id = ? AND collector = 'search:tinyfish'").get(jobId) as { searches_attempted: number; searches_ok: number } | undefined
  assert.ok(statsRow, 'the scan_source_stats row is persisted for the failed partial run')
  assert.equal(statsRow!.searches_attempted, 2, 'persisted stats: both searches attempted')
  assert.equal(statsRow!.searches_ok, 1, 'persisted stats: one search succeeded')
})

test('runJob: hold-stopped AFTER partial work reads partial_hold - not skipped, not an outage - with its evidence kept', async () => {
  const hit = { url: 'https://ex.com/x', title: 'X', snippet: 's', date: null }
  // The fetch is PRICED (env price read at call time) above the run budget: the searches ran, the fetch is refused.
  process.env.DAZL_SCAN_PRICE_TINYFISH_FETCH_USD = '0.01'
  let e: Awaited<ReturnType<typeof ending>>
  try {
    e = await ending(base({
      hits: [], modelQueries: ['London SaaS seed round', 'London SaaS startup funding'],
      hitsFor: (n: number) => n === 0 ? [hit] : [],
      tfPages: { 'https://ex.com/x': { title: 'X', text: 'evidence text' } },
      own: {}, extraction: [{ company: 'X Co', signal: 's', source_url: 'https://ex.com/x', excerpt: 'e', event_date: null }],
      runBudget: JSON.stringify({ max_usd: 0.005 }),
    }))
  } finally { delete process.env.DAZL_SCAN_PRICE_TINYFISH_FETCH_USD }
  const row = e.rows.find(r => r.collector === 'search:tinyfish') as { status?: string } | undefined
  assert.equal(row?.status, 'partial_hold:over_cap', `the source RAN (searches + fetches) then a later request was refused: ${JSON.stringify(e.rows)}`)
  const mapped = progressOf([{ collector: 'search:tinyfish', status: 'partial_hold:over_cap', evidence_count: null, candidate_count: null, verified_count: null, review_count: null }], 'failed')[0]
  assert.equal(mapped.status, 'partial', 'maps to partial, never to unavailable (no false outage) or skipped')
  assert.equal(mapped.note, 'stopped by the spending limit after partial results')
  // every hold reason maps to its own honest copy
  assert.equal(partialNote('partial_hold:accounting_uncertain'), 'stopped after a request may have been billed without a settled cost; partial results kept')
  assert.equal(partialNote('partial_hold:provider_rejected'), 'stopped after the provider rejected a request; partial results kept')
  assert.equal(partialNote('partial_hold'), 'stopped by the spend guard after partial results')
  assert.equal(e.r.report!.search.attempted, 1, 'the search that ran (the query-plan call was itself refused, so one fallback query) is retained in the run report')
  assert.equal(e.r.report!.search.hits_unique_urls, 1, 'the partial hit is not lost')
  // Persisted rows for the hold-stopped path too.
  const jobId2 = String((e.job as { id: string }).id)
  const repRow2 = e.r.db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(jobId2) as { report: string } | undefined
  assert.ok(repRow2, 'the scan_run_report row is persisted for the hold-stopped partial run')
  const repJson2 = JSON.parse(repRow2!.report) as { search: { attempted: number; hits_unique_urls: number } }
  assert.equal(repJson2.search.attempted, 1, 'persisted report: the search that ran is recorded')
  assert.equal(repJson2.search.hits_unique_urls, 1, 'persisted report: the partial hit is not lost')
  const statsRow2 = e.r.db.prepare("SELECT searches_attempted FROM scan_source_stats WHERE job_id = ? AND collector = 'search:tinyfish'").get(jobId2) as { searches_attempted: number } | undefined
  assert.ok(statsRow2, 'the scan_source_stats row is persisted for the hold-stopped partial run')
})

// The spend ledger (scan_spend_calls) in insertion order: the refusal-point evidence - WHICH reserve was refused first,
// with what reason - rather than aggregate vendor-call counters.
type SpendRow = { kind: string; attempt: number; status: string; reason: string | null }
const spendRows = (db: Database.Database): SpendRow[] => db.prepare('SELECT kind, attempt, status, reason FROM scan_spend_calls ORDER BY rowid').all() as SpendRow[]

test('runJob: CAUSAL - after the first search reserve is refused (query path), ZERO vendor requests are sent and the run halts', async () => {
  const fixture = {
    hits: [], modelQueries: ['London SaaS seed round', 'London SaaS startup funding'],
    hitsFor: (n: number) => n === 0 ? [{ url: 'https://ex.com/x', title: 'X', snippet: 's', date: null }] : [],
    tfPages: { 'https://ex.com/x': { title: 'X', text: 'evidence text' } },
    own: {}, extraction: [{ company: 'X Co', signal: 's', source_url: 'https://ex.com/x', excerpt: 'e', event_date: null }],
  }
  process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD = '0.001'
  let e: Awaited<ReturnType<typeof ending>>
  try {
    e = await ending(base({ ...fixture, runBudget: JSON.stringify({ max_usd: 0.0005 }) })) // every reserve exceeds the budget
  } finally { delete process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD }
  // Refusals are pre-call: NOTHING reached any vendor - no search, no fetch, no model prompt (plan or extraction) -
  // and the run HALTED honestly instead of continuing as a clean no-results.
  assert.equal(e.r.calls.searches.length, 0, `no search request was sent: ${JSON.stringify(e.r.calls.searches)}`)
  assert.equal(e.r.calls.tfFetchBatches.length, 0, 'no fetch request was sent')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request was sent (plan refused; extraction never reached)')
  assert.equal(e.r.extractionPrompt, '', 'the extraction stage after the search stage never ran')
  assert.equal(e.job.status, 'failed', JSON.stringify([e.job, e.outcome]))
  assert.equal(e.job.error, 'budget_stopped', `honest terminal state, never a clean zero-match: ${String(e.job.error)}`)
  // The refusal POINT, instrumented at both gates the run actually passes:
  //  - the PLAN call is refused by the per-run SpendGuard (prompt-estimate > max_usd) BEFORE the stub provider: no prompt
  //    was sent (calls.prompts, above) and the job's own reservation never moved (model calls persist there, not in
  //    scan_spend_calls);
  //  - the fallback query's SEARCH reserve is then the first - and only - scan_ledger row: refused, over_cap.
  const led1 = spendRows(e.r.db)
  assert.deepEqual(led1, [{ kind: 'tinyfish.search', attempt: 1, status: 'refused', reason: 'over_cap' }], `exactly one ledgered refusal - the fallback query search reserve; nothing settled, nothing after: ${JSON.stringify(led1)}`)
  const jr1 = e.r.db.prepare('SELECT spend_reserved_usd FROM scan_jobs').get() as { spend_reserved_usd: number | null }
  assert.equal(Number(jr1.spend_reserved_usd ?? 0), 0, "the plan's SpendGuard refusal left no reservation: the plan never sent, never billed")
  // CONTROL: the same fixture without the budget runs the plan, both searches, the fetch - the assertions are not vacuous.
  // CONTROL: the same fixture without the budget runs the plan, both searches, the fetch - the assertions are not vacuous.
  const c = await ending(base(fixture))
  assert.equal(c.r.calls.searches.length, 2, 'control: both searches run without the budget')
  assert.ok(c.r.calls.tfFetchBatches.length >= 1, 'control: the fetch stage runs without the budget')
  assert.ok(c.r.calls.prompts.length >= 1, 'control: the plan prompt runs without the budget')
})

test('runJob: CAUSAL - after a fetch reserve is refused (a search already settled), ZERO later vendor requests are sent', async () => {
  const fixture = {
    hits: [], modelQueries: ['London SaaS seed round', 'London SaaS startup funding'],
    hitsFor: (n: number) => n === 0 ? [{ url: 'https://ex.com/x', title: 'X', snippet: 's', date: null }] : [{ url: 'https://ex.com/y', title: 'Y', snippet: 's', date: null }],
    tfPages: { 'https://ex.com/x': { title: 'X', text: 'evidence text' }, 'https://ex.com/y': { title: 'Y', text: 'evidence text' } },
    own: {}, extraction: [{ company: 'X Co', signal: 's', source_url: 'https://ex.com/x', excerpt: 'e', event_date: null }],
  }
  process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD = '0.0001'
  process.env.DAZL_SCAN_PRICE_TINYFISH_FETCH_USD = '0.001'
  let e: Awaited<ReturnType<typeof ending>>
  try {
    e = await ending(base({ ...fixture, runBudget: JSON.stringify({ max_usd: 0.001 }) })) // search 1 settles (0.0001); the fetch reserve (0.001) -> refused pre-call
  } finally { delete process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD; delete process.env.DAZL_SCAN_PRICE_TINYFISH_FETCH_USD }
  // The search that settled before the refusal reached the vendor; the refused fetch never did, and the run HALTED:
  // nothing after the refusal (no fetch, no extraction, no further paid stage) ran.
  assert.equal(e.r.calls.searches.length, 1, `only the pre-refusal search reached the vendor: ${JSON.stringify(e.r.calls.searches)}`)
  assert.equal(e.r.calls.tfFetchBatches.length, 0, `the refused fetch never reached the vendor: ${JSON.stringify(e.r.calls.tfFetchBatches)}`)
  assert.equal(e.r.extractionPrompt, '', 'the extraction stage after the refusal never ran')
  assert.equal(e.job.status, 'failed', JSON.stringify([e.job, e.outcome]))
  assert.equal(e.job.error, 'budget_stopped', `honest terminal state: ${String(e.job.error)}`)
  // The refusal POINT on the ledger: the settled search row precedes the refused fetch row, and NOTHING was reserved
  // after the refusal (no extraction reserve): the halt is ledger-visible, not counter-visible.
  const led2 = spendRows(e.r.db)
  assert.equal(led2.length, 2, `the settled search, the refused fetch, and NOTHING after it (the run halted): ${JSON.stringify(led2)}`)
  assert.deepEqual(led2[0], { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null }, 'the pre-refusal search settled')
  assert.deepEqual(led2[1], { kind: 'tinyfish.fetch', attempt: 1, status: 'refused', reason: 'over_cap' }, 'the fetch reserve is the refusal point (the unpriced stub model leaves no llm rows on this path)')
  // CONTROL: the same fixture without the budget runs both searches and fetches both hits.
  const c = await ending(base(fixture))
  assert.equal(c.r.calls.searches.length, 2, 'control: both searches run without the budget')
  assert.equal(c.r.calls.tfFetchBatches.length, 1, 'control: both hits are fetched (one batch) without the budget')
})

test('runJob: CAUSAL - company path (three fixed queries, NO plan call): the first reserve refusal halts the run with ZERO vendor requests', async () => {
  // The company job has no LLM planning call: its FIRST paid reserve is the first TinyFish search. With the tenant cap
  // below one search reserve, that reserve is refused pre-call (over_cap), and the run must halt honestly.
  process.env.DAZL_SCAN_CAP_CAD = '0.0002'
  process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD = '0.001'
  let e: Awaited<ReturnType<typeof ending>>
  try {
    e = await ending(base({
      csvDomain: 'brightloop.example',
      hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }],
    }))
  } finally { delete process.env.DAZL_SCAN_CAP_CAD; delete process.env.DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD }
  assert.equal(e.r.calls.searches.length, 0, `the refused reserve never reached the vendor: ${JSON.stringify(e.r.calls.searches)}`)
  assert.equal(e.r.calls.tfFetchBatches.length, 0, 'no fetch request was sent')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request was sent (the company path has no plan call, and the refused run never reached one)')
  // The refusal POINT on the EXACT ledger: one refused tinyfish.search reserve (over_cap) and NOTHING else - after the
  // first refusal the run STOPS (no later reserve at all, not even a refused one: the paid research fallback never
  // runs). No llm plan row exists on this path. Causality from the ledger, not the counters.
  const led = spendRows(e.r.db)
  assert.deepEqual(led, [{ kind: 'tinyfish.search', attempt: 1, status: 'refused', reason: 'over_cap' }], `exactly one refused reserve, nothing before or after it: ${JSON.stringify(led)}`)
  assert.equal(e.job.status, 'failed', JSON.stringify([e.job, e.outcome]))
  assert.equal(e.job.error, 'budget_stopped', `the refusal ends the run as a budget stop, never a clean zero-match: ${String(e.job.error)}`)
  // Provenance: the source never ran - skipped_hold, never "had an error".
  assert.equal((e.rows.find(r => r.collector === 'search:tinyfish') as { status?: string } | undefined)?.status, 'skipped_hold')
  // CONTROL: the same company fixture without the tiny cap runs the three fixed searches.
  const c = await ending(base({ csvDomain: 'brightloop.example', hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }] }))
  assert.equal(c.r.calls.searches.length, 3, 'control: the three fixed company queries run without the cap')
})

// The company path applies the query path's rule: a sent request that may have been billed (5xx/timeout) or was
// rejected (403/429) ENDS the attempt - no paid research fallback, no later reserve, an honest terminal error that
// never reads as "nothing found". The sent request's row stays unsettled ('reserved': possibly billed, never re-run).
const companyFailure = (over: Partial<Fixture>) => ending(base({
  csvDomain: 'brightloop.example',
  hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }],
  ...over,
}))
const companyRow = (e: Awaited<ReturnType<typeof ending>>) => e.rows.find(r => r.collector === 'search:tinyfish') as { status?: string } | undefined

ptest('runJob: CAUSAL - company path: a sent search answered 5xx (maybe billed) ends accounting_uncertain, NO later paid reserve', async () => {
  const e = await companyFailure({ searchStatus: 500 })
  assert.equal(e.r.calls.searches.length, 1, 'the 5xx request WAS sent')
  assert.equal(e.r.calls.tfFetchBatches.length, 0, 'no fetch after the failure')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request after the failure (no fallback research, no extraction)')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT after the failure')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the fallback was never ENTERED: no search:anthropic source-run row exists: ${JSON.stringify(e.rows)}`)
  assert.deepEqual(spendRows(e.r.db), [{ kind: 'tinyfish.search', attempt: 1, status: 'reserved', reason: null }], 'the maybe-billed row stays reserved, never settled, and NOTHING was reserved after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'accounting_uncertain', `maybe billed, never re-run: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
  assert.equal(companyRow(e)?.status, 'error', 'a source that ran and failed reads error - never skipped, never ok')
  assert.match(e.outcome.detail ?? '', /did not run it again automatically/, 'the outcome says no automatic re-run (double-bill honesty)')
})

ptest('runJob: CAUSAL - company path: a sent search that times out (maybe billed) ends accounting_uncertain, NO later paid reserve', async () => {
  const e = await companyFailure({ searchTimeout: true })
  assert.equal(e.r.calls.searches.length, 1, 'the timed-out request WAS sent')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request after the timeout')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT after the failure')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the fallback was never ENTERED: no search:anthropic source-run row exists: ${JSON.stringify(e.rows)}`)
  assert.deepEqual(spendRows(e.r.db), [{ kind: 'tinyfish.search', attempt: 1, status: 'reserved', reason: null }], 'the maybe-billed row stays reserved and nothing follows it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'accounting_uncertain')
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
  assert.equal(companyRow(e)?.status, 'error')
})

test('runJob: CAUSAL - company path: a documented 403 rejection ends provider_rejected, NO later paid reserve', async () => {
  const e = await companyFailure({ searchStatus: 403 })
  assert.equal(e.r.calls.searches.length, 1, 'the rejected request WAS sent (a rejection is an answer, not a refusal)')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request after the rejection')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT after the failure')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the fallback was never ENTERED: no search:anthropic source-run row exists: ${JSON.stringify(e.rows)}`)
  const led = spendRows(e.r.db)
  assert.equal(led.length, 1, `exactly the rejected request's row, nothing after it: ${JSON.stringify(led)}`)
  assert.equal(led[0].kind, 'tinyfish.search'); assert.equal(led[0].attempt, 1); assert.equal(led[0].status, 'kept', 'a rejected call KEEPS its worst-case reservation and is marked rejected on the attempt - dazl does not claim it was uncharged')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'provider_rejected', `a documented rejection ends distinct, never retried: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
  assert.equal(companyRow(e)?.status, 'error')
})

test('runJob: CAUSAL - company path: a documented 429 rejection ends provider_rate_limited, NO later paid reserve', async () => {
  const e = await companyFailure({ searchStatus: 429 })
  assert.equal(e.r.calls.searches.length, 1, 'the rate-limited request WAS sent')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request after the rejection')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT after the rejection')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the fallback was never ENTERED: no search:anthropic source-run row exists: ${JSON.stringify(e.rows)}`)
  assert.deepEqual(spendRows(e.r.db), [{ kind: 'tinyfish.search', attempt: 1, status: 'kept', reason: null }], 'the rejected 429 KEEPS its worst-case reservation, marked rejected on the attempt with its ACTUAL status - nothing reserved after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'provider_rate_limited', `429 reads as rate-limited, not a generic failure: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
  assert.equal(companyRow(e)?.status, 'error')
})

ptest('runJob: CAUSAL - company path: searches clean, the FETCH batch answered 5xx (maybe billed): accounting_uncertain, NO later paid send', async () => {
  const e = await companyFailure({ hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], fetchStatus: 500 })
  assert.equal(e.r.calls.searches.length, 3, 'the three fixed searches ran clean')
  assert.equal(e.r.calls.tfFetchBatches.length, 1, 'the fetch batch WAS sent')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request was SENT after the failure (the hold/guard refuses pre-send)')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT after the failure')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the failure stays on the source that ran: ${JSON.stringify(e.rows)}`)
  assert.equal(companyRow(e)?.status, 'error', 'a source that ran and failed reads error - never skipped, never ok')
  assert.deepEqual(spendRows(e.r.db), [
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.fetch', attempt: 1, status: 'reserved', reason: null },
  ], 'the searches settled; the maybe-billed fetch stays reserved and NOTHING was reserved after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'accounting_uncertain', `maybe billed, never re-run: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
})

test('runJob: CAUSAL - company path: searches clean, the FETCH batch answered 429 (documented rejection): provider_rate_limited, NO later paid send', async () => {
  const e = await companyFailure({ hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], fetchStatus: 429 })
  assert.equal(e.r.calls.searches.length, 3, 'the three fixed searches ran clean')
  assert.equal(e.r.calls.tfFetchBatches.length, 1, 'the fetch batch WAS sent (a rejection is an answer, not a refusal)')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request was SENT after the rejection')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT after the rejection')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the rejection stays on the source that ran: ${JSON.stringify(e.rows)}`)
  assert.equal(companyRow(e)?.status, 'error')
  assert.deepEqual(spendRows(e.r.db), [
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.fetch', attempt: 1, status: 'kept', reason: null },
  ], 'the rejected fetch KEEPS its worst-case reservation with its ACTUAL 429 status on the attempt - nothing reserved after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'provider_rate_limited', `429 reads as rate-limited, not a generic failure: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
})

ptest('runJob: CAUSAL - company path: query 1 hits, query 2 answered 5xx (maybe billed): NO fetch send, accounting_uncertain', async () => {
  const e = await companyFailure({ hitsFor: (n) => n === 0 ? [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }] : [], searchStatusFor: (n) => n === 1 ? 500 : undefined })
  assert.equal(e.r.calls.searches.length, 2, 'query 1 ran clean, the query-2 request WAS sent')
  assert.equal(e.r.calls.tfFetchBatches.length, 0, 'the fetch batch was never SENT after the maybe-billed search')
  assert.equal(e.r.calls.prompts.length, 0, 'no model request was SENT after the failure')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT')
  assert.deepEqual(e.rows.map(r => r.collector), ['search:tinyfish'], `the failure stays on the source that ran: ${JSON.stringify(e.rows)}`)
  assert.equal(companyRow(e)?.status, 'error')
  assert.deepEqual(spendRows(e.r.db), [
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'reserved', reason: null },
  ], 'query 1 settled; the maybe-billed query 2 stays reserved; NOTHING reserved after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'accounting_uncertain', `maybe billed, never re-run: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
})

test('runJob: CAUSAL - company path: query 1 hits, query 2 answered 403 (documented rejection): NO fetch send, provider_rejected', async () => {
  const e = await companyFailure({ hitsFor: (n) => n === 0 ? [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }] : [], searchStatusFor: (n) => n === 1 ? 403 : undefined })
  assert.equal(e.r.calls.searches.length, 2, 'query 1 ran clean, the query-2 request WAS sent (a rejection is an answer)')
  assert.equal(e.r.calls.tfFetchBatches.length, 0, 'the fetch batch was never SENT after the rejection')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT')
  assert.deepEqual(spendRows(e.r.db), [
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'kept', reason: null },
  ], 'the rejected query KEEPS its worst-case reservation with its ACTUAL status on the attempt - nothing after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'provider_rejected', `a documented rejection ends distinct: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
  assert.equal(companyRow(e)?.status, 'error')
})

test('runJob: CAUSAL - company path: query 1 hits, query 2 answered 429: NO fetch send, provider_rate_limited', async () => {
  const e = await companyFailure({ hitsFor: (n) => n === 0 ? [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }] : [], searchStatusFor: (n) => n === 1 ? 429 : undefined })
  assert.equal(e.r.calls.searches.length, 2, 'query 1 ran clean, the query-2 request WAS sent')
  assert.equal(e.r.calls.tfFetchBatches.length, 0, 'the fetch batch was never SENT after the rejection')
  assert.equal(e.r.calls.research.length, 0, 'the paid research fallback was never SENT')
  assert.deepEqual(spendRows(e.r.db), [
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'kept', reason: null },
  ], 'the rejected 429 KEEPS its reservation - nothing reserved after it')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'provider_rate_limited', `429 reads as rate-limited: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'the terminal attempt never re-attempts')
  assert.equal(companyRow(e)?.status, 'error')
})

test('runJob: CAUSAL converse - company path: TinyFish cleanly empty, then the FALLBACK research answers 5xx: accounting_uncertain, both sources honest', async () => {
  const e = await companyFailure({ hits: [], researchError: true, researchRealReserve: true })
  assert.equal(e.r.calls.searches.length, 3, 'the three fixed company queries ran clean (empty is an answer, not a failure)')
  assert.equal(e.r.calls.research.length, 1, 'the paid fallback research was attempted once after the clean empty')
  assert.equal(e.r.extractionPrompt, '', 'nothing after the maybe-billed research failure ran')
  assert.equal(e.job.status, 'failed'); assert.equal(e.job.error, 'accounting_uncertain', `the maybe-billed research call ends the run uncertain: ${String(e.job.error)}`)
  assert.equal((e.r.db.prepare('SELECT attempts FROM scan_jobs').get() as { attempts: number }).attempts, 1, 'never re-attempted')
  // Provenance: the clean-empty source reads unavailable (a real zero), the source whose own request failed reads error.
  assert.equal(companyRow(e)?.status, 'unavailable', `TinyFish answered empty - never flipped to error: ${JSON.stringify(e.rows)}`)
  const fallback = e.rows.find(r => r.collector === 'search:anthropic') as { status?: string } | undefined
  assert.equal(fallback?.status, 'error', 'the source whose own request 5xx-ed is named failed')
  assert.match(e.outcome.detail ?? '', /did not run it again automatically/, 'the outcome says no automatic re-run')
  // The EXACT ledger: the three clean searches settled; the fallback research reserved through the REAL spend ledger
  // and its row stays 'reserved' (maybe billed, never settled) - the durable production-model uncertainty, not a stub signal.
  assert.deepEqual(spendRows(e.r.db), [
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'tinyfish.search', attempt: 1, status: 'settled', reason: null },
    { kind: 'llm.anthropic', attempt: 1, status: 'reserved', reason: null },
  ], 'three settled clean searches, then the maybe-billed research row left reserved - nothing after it')
})

test('runJob: company path CONTROL - the same fixture with no failure runs all three fixed searches and completes', async () => {
  const e = await companyFailure({})
  assert.equal(e.r.calls.searches.length, 3, 'the three fixed company queries run')
  assert.equal(e.job.status, 'done', JSON.stringify([e.job, e.outcome]))
  assert.ok(!['accounting_uncertain', 'provider_rejected', 'provider_rate_limited', 'budget_stopped'].includes(String(e.job.error)))
})

test('runJob: the TinyFish daily-allowance gate still returns the distinct cap outcome (not a spend refusal, no vendor call)', async () => {
  const { tfSearch, tfFetch, migrateTinyfish, resetTinyfishState } = await import('../lib/search/tinyfish.ts')
  const Database = (await import('better-sqlite3')).default
  const env = { TINYFISH_API_KEY: 'tf-secret-xyz', TINYFISH_SEARCHES_PER_SCAN: '5', TINYFISH_TENANT_DAILY: '1' } // one search a day per tenant
  const noCall = (async () => { throw new Error('the vendor must not be called once the daily gate is tripped') }) as unknown as typeof fetch
  const okCall = (async () => new Response('{"results":[]}', { status: 200 })) as unknown as typeof fetch
  const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState()
  const first = await tfSearch(db, 't1', 'ohio payroll hiring', {}, { searches: 0 }, { env, fetchImpl: okCall, now: 1_800_000_000 })
  assert.equal(first.ok, true, 'the first search uses the daily allowance')
  const s = await tfSearch(db, 't1', 'ohio payroll hiring again', {}, { searches: 1 }, { env, fetchImpl: noCall, now: 1_800_000_000 })
  assert.deepEqual(s, { ok: false, reason: 'cap' }, 'the daily-allowance gate is unchanged: a distinct cap outcome, never a SpendRefused')
  const envF = { TINYFISH_API_KEY: 'tf-secret-xyz', TINYFISH_TENANT_DAILY: '0' } // fetch room = tenantDaily - used(searches) <= 0 after the search above
  const f = await tfFetch(db, 't1', ['https://ex.com/x'], { fetches: 0 }, { env: { ...envF, TINYFISH_TENANT_DAILY: '1' }, fetchImpl: noCall, now: 1_800_000_000 })
  assert.deepEqual(f, { ok: false, reason: 'cap' }, 'the fetch daily-allowance gate is unchanged')
})

test('LIVE: while the scan is still running (the verifier is fetching), the search source already reports its progress', async () => {
  let seen: ReturnType<typeof progressOf> = []
  await runFixture(base({ onVerify: (db, jobId) => { seen = progressOf(sourceRuns(db, 'A', jobId) as Record<string, unknown>[], 'running') } }))
  const s = seen.find(p => p.source === 'search:tinyfish')
  assert.ok(s, `a live row exists mid-scan: ${JSON.stringify(seen)}`); assert.equal(s!.status, 'ok'); assert.equal(s!.candidates, 1)
})

test('state is one of queued/running/done/failed for the UI', async () => {
  const { progressOf } = await import('../lib/scan/progress.ts')
  const row = (status: string) => ({ collector: 'x', status, evidence_count: null, candidate_count: null, verified_count: null, review_count: null })
  assert.deepEqual(['queued', 'started', 'ok', 'error', 'empty'].map(s => progressOf([row(s)], 'running')[0].state), ['queued', 'running', 'done', 'failed', 'done'])
})

const R = (collector: string, status: string, evidence_count: number | null, candidate_count: number | null) => ({ collector, status, evidence_count, candidate_count, verified_count: null, review_count: null })
const SEARCH0 = { search: { attempted: 1, ok: 1, hits_raw: 0, hits_unique_urls: 0, hits_complete: true } }
const outcomeOf = (rows: ReturnType<typeof R>[], report: unknown = SEARCH0) => scanOutcome({ id: 'j', status: 'failed', error: 'no_candidates', candidates: 0, verified: 0, needs_review: 0, dropped: 0, ...outcomeInputs(report, rows, 'failed') } as never)

test('MIXED: search 0 hits but the job-board adapter returned 8 evidence items and 0 candidates is NOT a zero-results scan, and names the source', () => {
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'ok', 8, 0)])
  assert.notEqual(o.kind, 'zero_match'); assert.doesNotMatch(o.label + (o.detail ?? ''), /sources returned nothing|no results for this request/)
  assert.match(o.detail ?? '', /adapter:jobboards returned 8 items, none matched as candidates/)
})
test('MIXED: every recorded source returned nothing -> zero-match (the TinyFish unavailable row reads as empty because ITS report shows a clean 0; the news fallback must say empty itself)', () => {
  assert.equal(outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('search:news', 'empty', 0, null), R('adapter:jobboards', 'ok', 0, 0)]).kind, 'zero_match')
})
test('MIXED: one unavailable (not run / not configured) source blocks the zero claim and is named', () => {
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'unavailable', null, null)])
  assert.notEqual(o.kind, 'zero_match'); assert.match(o.detail ?? '', /adapter:jobboards was unavailable, not run or has no recorded counts/)
})
test('MIXED: an errored source is failed and named, not zero-match', () => {
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'error', null, null)])
  assert.equal(o.kind, 'failed'); assert.match(o.label, /adapter:jobboards/)
})
test('MIXED: with no search report at all, unavailable search collectors are unknown, never a zero', () => {
  assert.notEqual(outcomeOf([R('search:tinyfish', 'unavailable', null, null)], null).kind, 'zero_match')
})

test('REGRESSION: a clean empty TinyFish report never clears the news fallback — news hits with no usable page evidence are unknown, not zero', () => {
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('search:news', 'unavailable', 5, null)])
  assert.notEqual(o.kind, 'zero_match'); assert.doesNotMatch(o.label + (o.detail ?? ''), /sources returned nothing|no results for this request/)
  assert.match(o.detail ?? '', /search:news was unavailable, not run or has no recorded counts/)
  assert.deepEqual(outcomeInputs(SEARCH0, [R('search:news', 'unavailable', 5, null)], 'failed').unknown_sources, ['search:news'])
})
test('REGRESSION: 3 search attempts with only 1 successful and 0 hits is not zero-match and not "none failed": the failed attempts are named', () => {
  const rep = { search: { attempted: 3, ok: 1, hits_raw: 0, hits_unique_urls: 0, hits_complete: false } }
  const rows = [R('search:tinyfish', 'unavailable', null, null), R('search:news', 'empty', 0, null)]
  assert.deepEqual(outcomeInputs(rep, rows, 'failed').failed_sources, ['search:tinyfish (2 of 3 search attempts failed)'])
  const o = outcomeOf(rows, rep)
  assert.equal(o.kind, 'failed'); assert.match(o.label, /2 of 3 search attempts failed/); assert.doesNotMatch(o.detail ?? '', /none of them failed/)
})
test('a TinyFish source row that errored while its own attempts all failed is reported once', () => {
  assert.deepEqual(outcomeInputs({ search: { attempted: 2, ok: 0, hits_unique_urls: 0 } }, [R('search:tinyfish', 'error', null, null)], 'failed').failed_sources, ['search:tinyfish'])
})

test('REGRESSION: a job-board source with unknown (null) evidence/candidate counts is unknown — even on status ok, even queued — and blocks zero-match; it is named', () => {
  for (const [name, row] of [['ok, both counts null', R('adapter:jobboards', 'ok', null, null)], ['ok, candidates null', R('adapter:jobboards', 'ok', 0, null)], ['ok, evidence null', R('adapter:jobboards', 'ok', null, 0)], ['queued with zero counts', R('adapter:jobboards', 'queued', 0, 0)]] as const) {
    const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), row])
    assert.notEqual(o.kind, 'zero_match', name); assert.doesNotMatch(o.label + (o.detail ?? ''), /sources returned nothing|no results for this request/, name)
    assert.match(o.detail ?? '', /adapter:jobboards was unavailable, not run or has no recorded counts/, name)
    assert.deepEqual(outcomeInputs(SEARCH0, [row], 'failed').unknown_sources, ['adapter:jobboards'], name)
  }
  assert.equal(outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'ok', 0, 0)]).kind, 'zero_match', 'an explicit 0 and 0 is a real zero')
  assert.equal(outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'empty', null, null)]).kind, 'zero_match', 'the source itself says empty')
})

test('REGRESSION (Instinct): every news request returns HTTP 503 -> NOT a successful zero-result search; with a clean TinyFish 0 the scan is failed, not zero-match, and says so', async () => {
  resetNewsQueue()
  const r = await newsSearch(async () => ({ status: 503, body: 'upstream down' }), ['a', 'b', 'c'], 'en', { gapMs: 0, sleep: async () => {} })
  assert.deepEqual([r.hits.length, r.attempted, r.failed], [0, 3, 3])
  const note = { searched: true, hits: r.hits.length, attempted: r.attempted, failed: r.failed }
  assert.equal(newsStatus(null, note), 'error')
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('search:news', newsStatus(null, note), 0, null)])
  assert.equal(o.kind, 'failed'); assert.match(o.label, /search:news/); assert.doesNotMatch(o.label + (o.detail ?? ''), /sources returned nothing|none of them failed/)
})
test('news partial failure with zero hits is failed and named (2 of 3 requests); a fully answered zero is empty; hits without pages stay unknown', () => {
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 2 }), 'error_partial:2_of_3')
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('search:news', 'error_partial:2_of_3', 0, null)])
  assert.equal(o.kind, 'failed'); assert.match(o.label, /search:news \(2 of 3 requests failed\)/)
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 0 }), 'empty')
  assert.equal(newsStatus(null, { searched: true, hits: 4, attempted: 3, failed: 0 }), 'unavailable')
  assert.equal(newsStatus(null, { searched: false, hits: 0, attempted: 0, failed: 0 }), 'unavailable')
})

test('REGRESSION (Instinct): HTTP 200 with invalid HTML, an empty JSON object or a missing results field is a PARSE FAILURE — never a successful zero-result search', async () => {
  const { parseGdeltStrict } = await import('../lib/search/news.ts')
  for (const body of ['<html><body>Rate limit page</body></html>', '{}', '{"status":"ok"}', 'null', '[]', '{"articles":"none"}']) assert.equal(parseGdeltStrict(body), null, body)
  assert.deepEqual(parseGdeltStrict('{"articles":[]}'), [], 'an articles array, even empty, is a real answer')
  for (const body of ['<!doctype html><p>oops</p>', '{}', '{"unrelated":1}']) {
    resetNewsQueue()
    const r = await newsSearch(async () => ({ status: 200, body }), ['a', 'b'], 'en', { gapMs: 0, sleep: async () => {} })
    assert.deepEqual([r.hits.length, r.attempted, r.failed], [0, 2, 2], body)
    assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: r.attempted, failed: r.failed }), 'error', body)
    const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('search:news', newsStatus(null, { searched: true, hits: 0, attempted: 2, failed: 2 }), 0, null)])
    assert.equal(o.kind, 'failed'); assert.notEqual(o.kind, 'zero_match')
  }
})
test('REGRESSION: TinyFish search 200 with {} / no results array is a failed search (unavailable), not an ok zero; a real empty results array is still ok', async () => {
  const { tfSearch, migrateTinyfish, resetTinyfishState } = await import('../lib/search/tinyfish.ts')
  const { SearchTrace, summarizeTrace } = await import('../lib/search/trace.ts')
  const Database = (await import('better-sqlite3')).default
  const env = { TINYFISH_API_KEY: 'tf-secret-xyz', TINYFISH_SEARCHES_PER_SCAN: '5', TINYFISH_TENANT_DAILY: '50' }
  const res = (text: string) => (async () => new Response(text, { status: 200 })) as unknown as typeof fetch
  for (const [body, ok] of [['{}', false], ['null', false], ['<html>captcha</html>', false], ['{"results":"x"}', false], ['{"results":[]}', true]] as const) {
    const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); const trace = new SearchTrace()
    const r = await tfSearch(db, 't1', 'ohio payroll hiring', {}, { searches: 0 }, { env, fetchImpl: res(body), now: 1_800_000_000, trace })
    const s = summarizeTrace(trace)
    assert.equal(r.ok, ok, body); assert.equal(s.searches_ok, ok ? 1 : 0, `${body}: only a real results array counts as an ok search`)
    if (!ok) assert.equal(s.hits_raw, null, `${body}: no fabricated zero hits`)
  }
})
test('job boards: HTTP 200 with an empty object / no jobs array / invalid JSON is a partial (parse failure), and a partial source is unknown, never a zero', async () => {
  const { collectEvidenceReport } = await import('../lib/sources/index.ts')
  for (const body of ['{}', '<html>nope</html>', '{"jobs":"x"}']) {
    const http = (async (url: string) => (new URL(url).hostname === 'hn.algolia.com' ? { status: 404, body: '' } : { status: 200, body })) as never
    const r = await collectEvidenceReport({ adapters: ['jobboards'], feeds: ['https://boards.greenhouse.io/acme'], pages: [] }, 'London UK startups hiring sales account executives', http, 5000)
    assert.equal(r.runs[0].status, 'partial', body); assert.ok(r.runs[0].notes?.unparseable, body)
    const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'partial', 0, 0)])
    assert.notEqual(o.kind, 'zero_match', body); assert.match(o.detail ?? '', /adapter:jobboards/)
  }
})

test('REGRESSION (Instinct): article entries are validated — all-invalid entries and a null entry are a failed request (no throw); mixed valid + invalid keeps the valid hits and flags partial', async () => {
  const { parseGdeltDetail } = await import('../lib/search/news.ts')
  const good = { url: 'https://news.example.com/acme', title: 'Acme opens clinic', seendate: '20261020T101500Z' }
  assert.equal(parseGdeltDetail(JSON.stringify({ articles: [{ url: 5 }, { title: 'no url' }, 'str', 7] })), null, 'every entry invalid')
  assert.equal(parseGdeltDetail(JSON.stringify({ articles: [null] })), null, 'a null entry does not throw and is not a zero')
  assert.equal(parseGdeltDetail(JSON.stringify({ articles: [null, null] })), null)
  const mixed = parseGdeltDetail(JSON.stringify({ articles: [good, null, { url: 1 }] }))!
  assert.deepEqual([mixed.hits.length, mixed.malformed], [1, 2])
  const policy = parseGdeltDetail(JSON.stringify({ articles: [good, { url: 'http://insecure.example.com/x', title: 'x' }] }))!
  assert.deepEqual([policy.hits.length, policy.malformed], [1, 0], 'a well-formed non-https entry is a policy drop, not a malformed one')
  assert.deepEqual(parseGdeltDetail('{"articles":[]}'), { hits: [], malformed: 0 })
  for (const [articles, failed] of [[[{ url: 1 }, { title: 'x' }], 2], [[null], 2]] as const) {
    resetNewsQueue()
    const r = await newsSearch(async () => ({ status: 200, body: JSON.stringify({ articles }) }), ['a', 'b'], 'en', { gapMs: 0, sleep: async () => {} })
    assert.deepEqual([r.hits.length, r.attempted, r.failed], [0, 2, failed])
    assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 2, failed: r.failed, malformed: r.malformed }), 'error')
  }
  resetNewsQueue()
  const m = await newsSearch(async () => ({ status: 200, body: JSON.stringify({ articles: [good, null] }) }), ['a'], 'en', { gapMs: 0, sleep: async () => {} })
  assert.deepEqual([m.hits.length, m.failed, m.malformed], [1, 0, 1])
  assert.equal(newsStatus([{} as never], { searched: true, hits: 1, attempted: 1, failed: 0, malformed: 1 }), 'partial:malformed', 'valid hits kept, source flagged partial')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 1, failed: 0, malformed: 1 }), 'unavailable', 'unparsed entries beside no valid hit: unknown, never empty')
})

// ---- end to end: the news fallback with SOME requests failing ----
const gdeltBody = JSON.stringify({ articles: [{ url: NEWS, title: page.title, seendate: '20261016T100000Z' }] })
const newsFx = (status2: number, body2 = ''): Fixture => { let n = 0; return base({ hits: [], modelQueries: ['london saas startup seed round', 'london startup raises seed funding'], deps: { newsHttp: async () => (n++ === 0 ? { status: 200, body: gdeltBody } : { status: status2, body: body2 }) } }) }
test('END TO END: some news requests fail but another yields a lead -> progress shows search:news PARTIAL (never ok), and the scan outcome names it', async () => {
  const e = await ending(newsFx(503))
  const n = e.progress.find(p => p.source === 'search:news')!
  assert.equal(n.status, 'partial', JSON.stringify(e.rows)); assert.match(n.note ?? '', /^1 of 2 requests failed$/); assert.equal(n.state, 'done')
  assert.equal(e.outcome.kind, 'leads', JSON.stringify(e.outcome)); assert.match(e.outcome.detail ?? '', /Partial: search:news \(1 of 2 requests failed\)/)
})
test('END TO END: every news request fails -> search:news FAILED in progress and the outcome (never partial, never empty)', async () => {
  const f = newsFx(503); f.deps = { newsHttp: async () => ({ status: 503, body: '' }) }
  const e = await ending({ ...f, extraction: [] })
  assert.equal(e.progress.find(p => p.source === 'search:news')!.status, 'failed', JSON.stringify(e.rows))
  assert.equal(e.outcome.kind, 'failed'); assert.match(e.outcome.label, /search:news/)
})
test('partial vs ok vs empty: a partial source can never leave the outcome reading as zero-match, and progress carries the note', () => {
  const rows = [R('search:tinyfish', 'unavailable', null, null), R('search:news', 'partial:1_of_3', 0, null)]
  const p = progressOf(rows, 'failed').find(x => x.source === 'search:news')!
  assert.deepEqual([p.status, p.state, p.note], ['partial', 'done', '1 of 3 requests failed'])
  const o = outcomeOf(rows)
  assert.notEqual(o.kind, 'zero_match'); assert.match(o.detail ?? '', /search:news \(1 of 3 requests failed\)/)
  assert.deepEqual(['partial:malformed', 'partial'].map(s => progressOf([R('x', s, null, null)], 'done')[0].note), ['some of its answer could not be read', 'some of its answer could not be read'])
  assert.equal(newsStatus([{} as never], { searched: true, hits: 1, attempted: 3, failed: 1 }), 'partial:1_of_3')
  assert.equal(newsStatus([], { searched: true, hits: 0, attempted: 3, failed: 1 }), 'partial:1_of_3', 'an empty result with a failed request is not a plain empty')
  assert.equal(newsStatus(null, { searched: true, hits: 2, attempted: 3, failed: 1 }), 'partial:1_of_3')
  assert.equal(newsStatus([{} as never], { searched: true, hits: 1, attempted: 3, failed: 0 }), 'ok')
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 3, failed: 3 }), 'error')
})

test('END TO END (public status/outcome mapping): news hits with valid page evidence but the model extracts nothing -> search:news is no_candidates (evidence read), NOT empty, and the outcome is not zero-match', async () => {
  const f: Fixture = { ...base({ hits: [], modelQueries: ['london saas startup seed round', 'london startup raises seed funding'], deps: { newsHttp: async () => ({ status: 200, body: gdeltBody }) } }), extraction: [] }
  const e = await ending(f)
  const n = e.progress.find(p => p.source === 'search:news')!
  assert.equal(n.status, 'no_candidates', JSON.stringify(e.rows)); assert.equal(n.state, 'done'); assert.match(n.note ?? '', /items read, none extracted as candidates/)
  assert.notEqual(n.status as string, 'empty')
  assert.notEqual(e.outcome.kind, 'zero_match', JSON.stringify(e.outcome)); assert.match((e.outcome.detail ?? '') + e.outcome.label, /search:news returned \d+ items?, none matched as candidates/)
  assert.equal(outcomeInputs(null, e.rows, 'failed').evidence_sources.some(x => x.source === 'search:news'), true)
})
test('newsStatus: evidence + no extraction is no_candidates; zero hits is empty; the two are never conflated', () => {
  assert.equal(newsStatus([], { searched: true, hits: 2, attempted: 2, failed: 0 }), 'no_candidates')
  assert.equal(newsStatus([], { searched: true, hits: 0, attempted: 2, failed: 0 }), 'empty')
  assert.equal(newsStatus([], { searched: true, hits: 2, attempted: 2, failed: 1 }), 'partial:1_of_2', 'a failed request still wins')
})

test('REGRESSION (#352 review): a rate-limited news source is FAILED at the consumer layer - never ok, never a clean zero-match - and the copy names the throttling', () => {
  assert.equal(newsStatus(null, { searched: true, hits: 0, attempted: 1, failed: 0, limited: 1 }), 'limited')
  const rows = [R('search:tinyfish', 'unavailable', null, null), R('fallback:news', 'limited', 0, 0)]
  const prog = progressOf(rows, 'done')
  assert.equal(prog[1].status, 'failed', 'limited must never fall through to ok')
  assert.match(prog[1].note ?? '', /rate-limited by the provider/)
  const oi = outcomeInputs(SEARCH0, rows, 'failed')
  assert.deepEqual(oi.failed_sources, ['fallback:news (rate-limited by the provider, asked to slow down)'])
  assert.deepEqual(oi.partial_sources, [])
  const o = outcomeOf(rows)
  assert.equal(o.kind, 'failed', 'a throttled source with zero evidence is not a zero-match')
  assert.match(o.label, /fallback:news/)
  assert.doesNotMatch(o.label + (o.detail ?? ''), /sources returned nothing|none of them failed/)
})

test('mixed limited + failures + hits keeps the partial reason visible; limited_partial without hits is failed, never ok', () => {
  assert.equal(sourceStatusOf('limited_partial:2_of_3', false), 'failed')
  assert.equal(sourceStatusOf('partial:limited_1_of_3', false), 'partial')
  assert.equal(partialNote('partial:limited_1_of_3'), '1 of 3 requests rate-limited by the provider')
  assert.equal(partialNote('limited_partial:2_of_3'), 'rate-limited by the provider; 2 of 3 requests also failed')
  const o = outcomeOf([R('search:tinyfish', 'empty', null, null), R('search:news', 'partial:limited_1_of_3', 2, 0)])
  assert.equal(o.kind, 'none_extracted', 'a partial source can never leave the result reading as a clean zero')
  assert.match(o.detail ?? '', /rate-limited/)
})

test('mixed failed + limited + hits names BOTH reasons; the throttling is never hidden behind the failure count', () => {
  const st = newsStatus([{ company: 'X' } as never], { searched: true, hits: 2, attempted: 5, failed: 2, limited: 1 })
  assert.equal(st, 'partial:2_of_5_plus_1_limited')
  assert.equal(sourceStatusOf(st, false), 'partial')
  assert.equal(partialNote(st), '2 of 5 requests failed and 1 rate-limited by the provider')
  const o = outcomeOf([R('search:tinyfish', 'empty', null, null), R('search:news', st, 2, 1)])
  assert.match(o.detail ?? '', /2 of 5 requests failed and 1 rate-limited by the provider/)
})
