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

// ---- per-source progress EVENTS: the ordered sequence the UI can follow live and the history can replay ----
import { runReportFor } from '../lib/scan/run-report.ts'
const events = (r: Awaited<ReturnType<typeof runFixture>>, jobId: string) => ((runReportFor(r.db, 'A', jobId) as { progress_events?: { seq: number; source: string; state: string; status: string; found: number | null; kept: number | null }[] }[])[0]?.progress_events ?? [])
const seq = (ev: ReturnType<typeof events>, source: string) => ev.filter(e => e.source === source).map(e => `${e.state}${e.found === null ? '' : `(found ${e.found}${e.kept === null ? '' : `, kept ${e.kept}`})`}`).join(' > ')

test('PROGRESS EVENTS for the four endings: the returned outcome object and each source\'s event sequence (queued > running > done | failed, found, kept)', async () => {
  const cases: [string, Fixture, string][] = [
    ['leads-found', base(), 'yielded'],
    ['all-rejected', base({ hits: [{ url: B, title: pageB.title, snippet: QB, date: daysAgo(12) }], extraction: [candB] }), 'rejected'],
    ['zero-match', base({ hits: [], tfPages: {}, own: {}, extraction: [] }), 'no_match'],
    ['failed', base({ searchStatus: 503, extraction: [] }), 'failed'],
  ]
  for (const [name, f, cls] of cases) {
    const r = await runFixture(f); const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
    const stored = storedOutcomeFor(r.db, 'A', jobId)!, ev = events(r, jobId)
    console.log(`# ${name}: outcome ${JSON.stringify({ class: stored.class, label: stored.label, counts: stored.counts, reasons: stored.reasons, failed_sources: stored.failed_sources })}`)
    for (const s of [...new Set(ev.map(e => e.source))]) console.log(`#   ${s}: ${seq(ev, s)}  [${ev.filter(e => e.source === s).map(e => e.status).join(',')}]`)
    assert.equal(stored.class, cls, name); assert.ok(ev.length > 0 && ev.every((e, i) => e.seq === i + 1), `${name}: ordered events`)
    for (const s of new Set(ev.map(e => e.source))) { const states = ev.filter(e => e.source === s).map(e => e.state); assert.ok(['queued', 'running', 'done', 'failed'].includes(states[states.length - 1]), `${name} ${s}: ends in a terminal state`); const firstTerminal = states.findIndex(x => x === 'done' || x === 'failed'); assert.ok(firstTerminal < 0 || states.slice(firstTerminal).every(x => x === 'done' || x === 'failed'), `${name} ${s}: once terminal, never queued / running again`) }
  }
})
test('the TinyFish source is queued before it runs, and a successful one ends done with found and kept; a failed one ends failed', async () => {
  const ok = await runFixture(base()); const okId = (ok.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id; const okSeq = events(ok, okId).filter(e => e.source === 'search:tinyfish')
  assert.deepEqual(okSeq.map(e => e.state).slice(0, 2), ['queued', 'running']); assert.deepEqual([okSeq.at(-1)!.state, okSeq.at(-1)!.found, okSeq.at(-1)!.kept], ['done', 2, 1])
  const bad = await runFixture(base({ searchStatus: 503, extraction: [] })); const badId = (bad.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  assert.equal(events(bad, badId).filter(e => e.source === 'search:tinyfish').at(-1)!.state, 'failed')
})
