// A scan ends in exactly one of four honest ways, and a running scan shows per-source progress as data the UX can poll. Stubbed sources and pages, invented companies, no network.
//   failed (which source) | rejected (counts per reason) | zero-match (the sources returned nothing) | yielded N leads
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { progressOf, outcomeInputs, sourceStatusOf } from '../lib/scan/progress.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
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
  assert.deepEqual(by(live, 'search:tinyfish'), { source: 'search:tinyfish', state: 'done', status: 'ok', candidates: 4, accepted: 2, review: 1, rejected: 1 })
  assert.deepEqual(by(live, 'search:news'), { source: 'search:news', state: 'running', status: 'running', candidates: null, accepted: null, review: null, rejected: null })
  assert.equal(by(live, 'adapter:jobboards').status, 'skipped'); assert.equal(by(live, 'advanced:x').status, 'unavailable', 'no data from it is not proof that it failed'); assert.equal(by(live, 'search:anthropic').status, 'empty')
  assert.equal(by(progressOf(rows, 'done'), 'search:news').status, 'failed', 'started but never reported, and the scan is over')
  assert.equal(sourceStatusOf('started', true), 'running')
  assert.deepEqual(outcomeInputs(null, rows, 'done').failed_sources, ['search:news'], 'only a source that never reported is failed; unavailable is not')
  assert.deepEqual(progressOf([{ collector: 'search:x', status: 'error', evidence_count: null, candidate_count: null, verified_count: null, review_count: null }], 'done')[0].status, 'failed')
  assert.deepEqual(outcomeInputs({ funnel: { review_reasons: { quote_unconfirmed: 2 }, drop_reasons: { duplicate: 1 } }, search: { hits_unique_urls: 6, attempted: 3, ok: 3 } }, [], 'done'), { failed_sources: [], reject_reasons: { 'review:quote_unconfirmed': 2, 'dropped:duplicate': 1 }, search_hits: 6, evidence_sources: [], unknown_sources: [] })
  assert.deepEqual(outcomeInputs({ search: { attempted: 3, ok: 0, hits_unique_urls: 0 } }, [], 'done').failed_sources, ['search:tinyfish'], 'every search attempt failed: a failed source, not an empty result')
})

// ---- through the real runJob (stubbed search, pages and extraction) ----
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const page = { title: 'Brightloop raises seed round', text: `Published ${daysAgo(12)}. ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
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

test('runJob: FAILED — the search source answers 500: the outcome names the source and is not "zero-match"', async () => {
  const e = await ending(base({ hits: [], tfPages: {}, own: {}, extraction: [], searchStatus: 500 }))
  assert.equal(e.outcome.kind, 'failed', JSON.stringify([e.outcome, e.job, e.rows])); assert.match(e.outcome.label, /^Failed - search:tinyfish had an error/)
  assert.notEqual(e.outcome.kind, 'zero_match')
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
test('MIXED: every recorded source returned nothing -> zero-match (the search collectors read as empty because the search report shows a clean 0)', () => {
  assert.equal(outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('search:news', 'unavailable', null, null), R('adapter:jobboards', 'ok', 0, 0)]).kind, 'zero_match')
})
test('MIXED: one unavailable (not run / not configured) source blocks the zero claim and is named', () => {
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'unavailable', null, null)])
  assert.notEqual(o.kind, 'zero_match'); assert.match(o.detail ?? '', /adapter:jobboards was unavailable or not run/)
})
test('MIXED: an errored source is failed and named, not zero-match', () => {
  const o = outcomeOf([R('search:tinyfish', 'unavailable', null, null), R('adapter:jobboards', 'error', null, null)])
  assert.equal(o.kind, 'failed'); assert.match(o.label, /adapter:jobboards/)
})
test('MIXED: with no search report at all, unavailable search collectors are unknown, never a zero', () => {
  assert.notEqual(outcomeOf([R('search:tinyfish', 'unavailable', null, null)], null).kind, 'zero_match')
})
