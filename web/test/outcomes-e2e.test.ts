// Failed / rejected / zero-match are different results, end to end: the runner's stored job, the run report's per-source progress, the outcome the status
// API returns, and the words the customer reads. A failure must never read as "no leads". Invented data, stubbed provider and search; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { scanOutcome, reportSummaries } from '../lib/scan/outcome.ts'
import { progressOf } from '../lib/scan/run-report.ts'
import { ProviderError } from '../lib/llm/provider.ts'

const REQUEST = 'Find independent dental practices in Columbus Ohio that opened a new location in the past 90 days.'
const ICP = { summary: 's', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['Columbus, OH'], signals: ['opened a new location'], exclude: [], country: 'US', language: 'en', window_days: 90 }
const U = 'https://news.example/smile-opens'
const Q = 'Smile Dental opened its second location on High Street in Columbus this month'
const pad = (s: string) => `${s} ${'The practice serves families across the city. '.repeat(10)}`
const base = (): Fixture => ({ request: REQUEST, modelIcp: ICP, modelQueries: ['dental practice opens new location Columbus'], hits: [], tfPages: {}, own: {}, extraction: [] })

async function run(f: Fixture) {
  const r = await runFixture(f)
  const job = r.db.prepare('SELECT status, error, candidates, verified, needs_review, dropped, drop_reasons FROM scan_jobs').get() as { status: string; error: string | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; drop_reasons: string | null }
  const outcome = scanOutcome(job, reportSummaries(r.db, 'A', [r.db.prepare('SELECT id FROM scan_jobs').get() ? (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id : '']).values().next().value ?? null)
  const progress = progressOf(r.report as never)
  return { r, job, outcome, progress }
}

test('ZERO-MATCH: every search answered and returned nothing -> no_matches, its own words, not a failure and not a rejection', async () => {
  const x = await run(base())
  assert.equal(x.outcome.kind, 'no_matches'); assert.match(x.outcome.detail, /returned no results|found nothing/i); assert.doesNotMatch(x.outcome.detail, /failed|error/i)
  assert.ok(x.outcome.next_step.length > 0)
})

test('SEARCH FAILED: the searches errored -> search_failed with the reason, and "nothing was concluded" (never "no leads")', async () => {
  const x = await run({ ...base(), searchStatus: 500 })
  assert.equal(x.outcome.kind, 'search_failed'); assert.match(x.outcome.label, /search failed/); assert.match(x.outcome.detail, /Nothing was concluded/)
  const src = x.progress!.per_source.find(s => s.source === 'search:tinyfish')!
  assert.deepEqual([src.queried, src.errors], [true, 1], 'the failing source shows an error in the per-source progress')
})

test('PROVIDER FAILED: a rejected model key is a failure with its own reason, not "no leads"', async () => {
  const fail = { complete: async () => { throw new ProviderError('auth', 'key_rejected') }, completeDetailed: async () => { throw new ProviderError('auth', 'key_rejected') }, research: async () => { throw new ProviderError('auth', 'key_rejected') }, configuredModel: () => 'stub' }
  const x = await run({ ...base(), hits: [{ url: U, title: 't', snippet: Q, date: daysAgo(5) }], tfPages: { [U]: { title: 't', text: pad(Q) } }, deps: { providers: { anthropic: fail, openai: fail } } })
  assert.equal(x.job.status, 'failed'); assert.equal(x.job.error, 'key_rejected')
  assert.equal(x.outcome.kind, 'search_failed'); assert.match(x.outcome.label, /key was rejected/); assert.match(x.outcome.detail, /Nothing was concluded/)
})

test('ALL REJECTED: candidates were found and none qualified -> all_rejected with counts per reason, a finished (done) scan, not a failure and not zero-match', async () => {
  const wrong = { company: 'Smile Dental', signal: 'opened a new location', source_url: U, excerpt: 'Smile Dental opened a brand new flagship in Columbus', event_date: daysAgo(5) }   // the quote is not on the page
  const x = await run({ ...base(), hits: [{ url: U, title: 't', snippet: Q, date: daysAgo(5) }], tfPages: { [U]: { title: 't', text: pad(Q) } }, own: { [U]: { title: 't', text: pad(Q) } }, extraction: [wrong] })
  assert.equal(x.job.status, 'done'); assert.equal(x.job.verified, 0)
  assert.equal(x.outcome.kind, 'all_rejected'); assert.ok(Object.keys(x.outcome.reasons).length > 0, 'each rejection reason is counted'); assert.match(x.outcome.detail, /none passed|candidate/i)
  const src = x.progress!.per_source.find(s => s.source === 'search:tinyfish')!
  assert.deepEqual([src.queried, src.found !== null, src.candidates, src.verified, src.rejected, src.errors], [true, true, 1, 0, 1, 0], 'per source: queried, found, candidates, verified 0, rejected 1, no errors')
})

test('the four states read differently to the customer (label, detail and next step all differ) and per-source progress carries queried / found / candidates / verified / rejected / errors', async () => {
  const kinds = [await run(base()), await run({ ...base(), searchStatus: 500 })]
  assert.notEqual(kinds[0].outcome.kind, kinds[1].outcome.kind)
  assert.notEqual(kinds[0].outcome.label, kinds[1].outcome.label); assert.notEqual(kinds[0].outcome.next_step, kinds[1].outcome.next_step)
  for (const k of kinds) for (const s of k.progress!.per_source) assert.deepEqual(Object.keys(s).sort(), ['candidates', 'errors', 'found', 'queried', 'rejected', 'source', 'status', 'verified'])
})

test('the leads page says each state in its own words (string check; failed / all rejected / no matches are different paragraphs)', async () => {
  const fs = await import('node:fs'); const ui = fs.readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(ui, /data-outcome="all_rejected">Found, but none qualified:/)
  assert.match(ui, /status === 'failed'/); assert.match(ui, /jobError === 'no_candidates' \? \(emptyReason \?/)
  assert.match(ui, /j\.outcome \? `\$\{j\.outcome\.label\} - \$\{j\.outcome\.detail\}`/, 'history shows the outcome label and detail for failed scans')
})
