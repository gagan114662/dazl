// A scan ends in one DISTINCT, stored result: failed / extraction_failed / rejected / no_match / yielded (and stopped), each with counts per reason and the per-source numbers the UI polls.
// Stubbed search / pages / extraction through the real runJob; invented companies; no network, no key, no credits. The stored result of each replay is printed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { storedOutcomeFor, buildStoredOutcome, outcomeClass } from '../lib/scan/stored-outcome.ts'

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const A = 'https://sifted.example/brightloop-raises-seed', B = 'https://sifted.example/orbitly-raises-seed'
const QA = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month', QB = 'Orbitly, a London B2B SaaS startup, raised a 2m GBP seed round this month'
const pad = (s: string) => `${s} ${'More about the company and its people. '.repeat(15)}`
const pageA = { title: 'Brightloop raises seed', text: pad(`Published ${daysAgo(12)}. ${QA}.`) }
const pageB = { title: 'Orbitly raises seed', text: pad(`Published ${daysAgo(12)}. An article about London startups in general.`) }   // does NOT carry Orbitly's quote
const candA: Cand = { company: 'Brightloop', signal: 'raised a seed round', source_url: A, excerpt: QA, event_date: daysAgo(12) }
const candB: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: B, excerpt: QB, event_date: daysAgo(12) }
const base = (over: Partial<Fixture> = {}): Fixture => ({ request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: A, title: pageA.title, snippet: QA, date: daysAgo(12) }, { url: B, title: pageB.title, snippet: QB, date: daysAgo(12) }],
  tfPages: { [A]: pageA, [B]: pageB }, own: { [A]: pageA, [B]: pageB }, extraction: [candA, candB], ...over })
async function end(f: Fixture) {
  const r = await runFixture(f); const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const stored = storedOutcomeFor(r.db, 'A', jobId); console.log(`# stored ${JSON.stringify(stored && { class: stored.class, kind: stored.kind, label: stored.label, counts: stored.counts, reasons: stored.reasons, failed: stored.failed_sources, sources: stored.sources.map(s => `${s.source}:${s.status}:${s.found}/${s.kept}/${s.rejected}`) })}`)
  return { r, jobId, stored: stored! }
}

test('FAILED (technical): every search answers 503 - the ending is failed, names the source, and is not an empty search', async () => {
  const { stored } = await end(base({ searchStatus: 503, extraction: [] }))
  assert.equal(stored.class, 'failed'); assert.ok(stored.failed_sources.length >= 1, JSON.stringify(stored)); assert.match(stored.label, /^Failed - /); assert.equal(stored.counts.verified, null)
})
test('NO MATCH: every source answered and returned nothing, none failed', async () => {
  const { stored } = await end(base({ hits: [], tfPages: {}, own: {}, extraction: [] }))
  assert.equal(stored.class, 'no_match', JSON.stringify(stored)); assert.match(stored.label, /^Zero match/); assert.deepEqual(stored.failed_sources, [])
})
test('EXTRACTION FAILED: pages were read but no candidate could be extracted - not "nothing matched", not a technical failure', async () => {
  const { stored } = await end(base({ extraction: [] }))
  assert.equal(stored.class, 'extraction_failed', JSON.stringify(stored)); assert.deepEqual(stored.failed_sources, [])
})
test('REJECTED: companies were found and none passed the checks - counts per reason are stored (here: the quote is not on the page)', async () => {
  const { stored } = await end(base({ hits: [{ url: B, title: pageB.title, snippet: QB, date: daysAgo(12) }], extraction: [candB] }))
  assert.equal(stored.class, 'rejected', JSON.stringify(stored)); assert.equal(stored.counts.found, 1); assert.equal(stored.counts.verified, 0)
  assert.ok(Object.keys(stored.reasons).length > 0 || (stored.counts.needs_review ?? 0) + (stored.counts.dropped ?? 0) === 1, JSON.stringify(stored)); assert.match(stored.label, /found/)
})
test('MIXED SUCCESS: one lead passes, one is rejected - yielded, with the held one counted and its reason', async () => {
  const { stored } = await end(base())
  assert.equal(stored.class, 'yielded', JSON.stringify(stored)); assert.equal(stored.counts.found, 2); assert.equal(stored.counts.verified, 1)
  assert.equal((stored.counts.needs_review ?? 0) + (stored.counts.dropped ?? 0), 1); assert.ok(Object.values(stored.reasons).reduce((a, b) => a + b, 0) >= 1, JSON.stringify(stored.reasons))
})
test('PER-SOURCE POLLING DATA: each source row has name, status, found / kept / rejected, so the UI can poll it; the live status and the stored one agree', async () => {
  const { r, jobId, stored } = await end(base())
  for (const s of stored.sources) { assert.ok(s.source && s.status && s.state); assert.ok('found' in s && 'kept' in s && 'rejected' in s) }
  const src = stored.sources.find(s => s.found !== null)!; assert.ok(src, JSON.stringify(stored.sources)); assert.equal(src.found, 2); assert.equal(src.kept, 1)
  const live = buildStoredOutcome(r.db, 'A', jobId)!; assert.equal(live.class, stored.class); assert.deepEqual(live.counts, stored.counts)
  assert.equal(buildStoredOutcome(r.db, 'B', jobId), null, 'another tenant sees nothing'); assert.equal(storedOutcomeFor(r.db, 'B', jobId), null)
})
test('the classes are distinct: every scan-outcome kind maps to exactly one class, and the three honest endings never collapse', () => {
  assert.deepEqual((['failed', 'stopped', 'none_extracted', 'all_dropped', 'review_only', 'zero_match', 'leads', 'running', 'enriching', 'unrecorded'] as const).map(outcomeClass), ['failed', 'stopped', 'extraction_failed', 'rejected', 'rejected', 'no_match', 'yielded', 'active', 'active', 'unrecorded'])
})
