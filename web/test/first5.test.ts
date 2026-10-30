// "First 5": the fast first scan of a new account — free sources only, verified leads as a view the UX polls, "finding more..." while it runs or falls short, and never an empty state.
// Stubbed news / pages / extraction, invented company, no network, no key, no credits. Timings printed here are STUB timings, not live latency.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { progressOf, outcomeInputs } from '../lib/scan/progress.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import { first5Of, isFirst5, verifiedLeads, FIRST5_TARGET, type First5Lead } from '../lib/scan/first5.ts'
import { normalizeScanBudget, describeRunBudget } from '../lib/scan/run-budget.ts'
import { migrateTinyfish } from '../lib/search/tinyfish.ts'
import { parseRunBudget } from '../lib/scan/runner.ts'

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const page = { title: 'Brightloop raises seed round', text: `On ${daysAgo(12)}, ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
const BUDGET = JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false })
const gdelt = JSON.stringify({ articles: [{ url: NEWS, title: page.title, seendate: '20261016T100000Z' }] })
const fx = (over: Partial<Fixture> = {}): Fixture => ({ request: REQUEST, modelIcp: ICP, modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
  extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: QUOTE, event_date: daysAgo(12) }], runBudget: BUDGET, deps: { newsHttp: async () => ({ status: 200, body: gdelt }) }, ...over })
async function view(f: Fixture) {
  const t0 = Date.now(); const r = await runFixture(f); const ms = Date.now() - t0
  const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const rows = sourceRuns(r.db, 'A', jobId) as Record<string, unknown>[]
  const rep = (runReportFor(r.db, 'A', jobId) ?? []).at(-1) ?? null
  const job = r.db.prepare('SELECT id, status, error, candidates, verified, needs_review, dropped FROM scan_jobs').get() as Record<string, unknown>
  const progress = progressOf(rows, String(job.status)); const outcome = scanOutcome({ ...job, ...outcomeInputs(rep, rows, String(job.status)) } as never)
  return { r, ms, jobId, v: first5Of({ status: String(job.status), leads: verifiedLeads(r.db, 'A', jobId), progress, outcome }), progress, outcome }
}
const lead = (i: number): First5Lead => ({ id: `l${i}`, company: `Co${i}`, name: null, signal: 's', source_url: 'https://x.example/1', event_date: null, published_at: null, fit_pct: null, provisional: false })
const noOutcome = scanOutcome({ id: 'j', status: 'done', error: null })

test('pure: the view is never empty — finding / partial / ready / stopped_empty each carry a message, the sources and what to do next', () => {
  const running = first5Of({ status: 'running', leads: [], progress: [], outcome: noOutcome }); assert.deepEqual([running.state, running.finding_more, running.can_continue], ['finding', true, false]); assert.match(running.message, /Searching/)
  const some = first5Of({ status: 'running', leads: [lead(1), lead(2)], progress: [], outcome: noOutcome }); assert.equal(some.state, 'finding'); assert.match(some.message, /Searching the free sources/)
  const part = first5Of({ status: 'done', leads: [lead(1), lead(2), lead(3)], progress: [], outcome: noOutcome }); assert.deepEqual([part.state, part.finding_more, part.can_continue, part.verified, part.next?.action], ['partial', false, true, 3, 'wider_search']); assert.match(part.message, /3 of 5 verified from the free sources. You can search wider/)
  const ready = first5Of({ status: 'done', leads: [1, 2, 3, 4, 5, 6, 7].map(lead), progress: [], outcome: noOutcome }); assert.deepEqual([ready.state, ready.finding_more, ready.verified, ready.leads.length], ['ready', false, FIRST5_TARGET, FIRST5_TARGET])
})
test('pure: nothing verified says WHICH of the distinct stops it was — failed source, rejected candidates, clean zero — and names the failed source', () => {
  const stop = (status: string, error: string | null, o: object) => first5Of({ status, leads: [], progress: o && (o as { progress?: never }).progress ? (o as { progress: never }).progress : [], outcome: scanOutcome({ id: 'j', status, error, ...o } as never) })
  const f = stop('failed', 'no_candidates', { failed_sources: ['search:news'], search_hits: 0 }); assert.deepEqual([f.state, f.reason, f.finding_more, f.can_continue], ['stopped_empty', 'failed', false, true]); assert.match(f.message, /search:news/)
  const rj = stop('done', null, { candidates: 4, verified: 0, needs_review: 0, dropped: 4, reject_reasons: { 'dropped:excerpt_not_on_page': 4 } }); assert.equal(rj.reason, 'rejected'); assert.match(rj.message, /Rejected: excerpt not on page x4/)
  const z = stop('failed', 'no_candidates', { search_hits: 0, failed_sources: [] }); assert.equal(z.reason, 'zero_match')
  assert.equal(new Set([f.reason, rj.reason, z.reason]).size, 3); for (const v of [f, rj, z]) assert.ok(v.message.length > 20 && /You can search wider/.test(v.message) && !/Finding more/.test(v.message) && v.finding_more === false && v.next?.action === 'wider_search')
})
test('budget: mode first5 stores first5 + both paid switches off; first5 accepts only true; the runner reads it back', () => {
  const ok = normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true); assert.ok(ok.ok); assert.deepEqual(parseRunBudget(ok.ok ? ok.value : null), { first5: true, paid_fallback: false, credit_enrichment: false })
  assert.equal(normalizeScanBudget({ first5: false }, true).ok, false); assert.equal(normalizeScanBudget({ first5: 'yes' }, true).ok, false)
  assert.equal(parseRunBudget('{"first5":false}'), null)
})
test('THE FAST PATH: a first5 job uses the free news source, makes NO TinyFish search and no paid research, and the view shows the verified lead with "finding more" (1 < 5)', async () => {
  const { r, v, ms, progress } = await view(fx())
  assert.equal(r.calls.searches.length, 0, 'TinyFish is not asked'); assert.ok(isFirst5(r.db, 'A', r.job ? (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id : ''))
  assert.deepEqual([v.state, v.verified, v.finding_more, v.can_continue], ['partial', 1, false, true], JSON.stringify(v))
  assert.equal(v.leads[0].company, 'Brightloop'); assert.equal(v.leads[0].source_url, NEWS); assert.equal(v.leads[0].fit_pct, null, 'no fit grade stored: no fit claimed'); assert.equal(v.leads[0].name, null)
  const news = v.sources.find(s => s.source === 'search:news')!; assert.deepEqual([news.state, news.status, news.accepted], ['done', 'ok', 1]); assert.ok(!progress.some(p => p.source === 'search:tinyfish'), 'no row for a source that never ran')
  console.log(`# stub timing: first5 job end to end ${ms} ms (stubbed network, NOT live latency)`)
})
test('CONTROL: the same job WITHOUT first5 still searches TinyFish first', async () => {
  const r = await runFixture(fx({ runBudget: undefined })); assert.ok(r.calls.searches.length >= 1)
})
test('every news request fails -> stopped_empty, reason failed, search:news named, can continue: a distinct failure, not an empty screen', async () => {
  const { v } = await view(fx({ extraction: [], deps: { newsHttp: async () => ({ status: 503, body: '' }) } }))
  assert.deepEqual([v.state, v.reason, v.verified, v.can_continue], ['stopped_empty', 'failed', 0, true], JSON.stringify(v)); assert.deepEqual(v.failed_sources, ['search:news']); assert.match(v.message, /search:news/)
})
test('a candidate the verifier rejects (quote not on the page) -> stopped_empty with reason rejected + counts, not a failure and not a zero', async () => {
  const { v } = await view(fx({ own: { [NEWS]: { title: 'x', text: `On ${daysAgo(12)}, An unrelated article. ${'Filler text. '.repeat(40)}` } } }))
  assert.equal(v.verified, 0); assert.equal(v.state, 'stopped_empty'); assert.ok(v.reason === 'rejected', JSON.stringify(v)); assert.match(v.message, /You can search wider/)
})
test('SCOPE: verifiedLeads is owner-scoped and drops held / quarantined leads; a non-first5 job is not a first5 job', async () => {
  const { r, jobId } = await view(fx())
  assert.equal(verifiedLeads(r.db, 'A', jobId).length, 1); assert.equal(verifiedLeads(r.db, 'B', jobId).length, 0, 'another tenant sees nothing')
  r.db.prepare("UPDATE leads SET quarantined_at = 1 WHERE scan_job_id = ?").run(jobId); assert.equal(verifiedLeads(r.db, 'A', jobId).length, 0)
  r.db.prepare("UPDATE leads SET quarantined_at = NULL, review_reason = 'quote_unconfirmed' WHERE scan_job_id = ?").run(jobId); assert.equal(verifiedLeads(r.db, 'A', jobId).length, 0, 'held for review is not verified')
  r.db.prepare("UPDATE scan_jobs SET run_budget = NULL WHERE id = ?").run(jobId); assert.equal(isFirst5(r.db, 'A', jobId), false)
})

// ---- #324 review (head 9630347) ----
test('ENRICHING is active: no leads yet is "finding", not stopped_empty; five provisional rows are NOT ready and count 0 verified; no second scan is offered', () => {
  const none = first5Of({ status: 'enriching', leads: [], progress: [], outcome: scanOutcome({ id: 'j', status: 'done', error: null }) })
  assert.deepEqual([none.state, none.finding_more, none.can_continue, none.next, none.enriching, none.reason], ['finding', true, false, null, true, null])
  const five = first5Of({ status: 'enriching', leads: [1, 2, 3, 4, 5].map(lead), progress: [], outcome: noOutcome })
  assert.deepEqual([five.state, five.verified, five.found, five.can_continue, five.leads.every(l => l.provisional)], ['finding', 0, 5, false, true]); assert.match(five.message, /5 found. Checking each one/)
  const fin = first5Of({ status: 'done', leads: [1, 2, 3, 4, 5].map(lead), progress: [], outcome: noOutcome }); assert.deepEqual([fin.state, fin.verified, fin.leads.some(l => l.provisional)], ['ready', 5, false])
})
test('TERMINAL states claim no background work: partial / failed / zero-match / rejected all have finding_more false, say the real result, and offer a deliberate wider search', () => {
  const stop = (status: string, error: string | null, o: object) => first5Of({ status, leads: [], progress: [], outcome: scanOutcome({ id: 'j', status, error, ...o } as never) })
  const views = [first5Of({ status: 'done', leads: [lead(1)], progress: [], outcome: noOutcome }), stop('failed', 'no_candidates', { search_hits: 0, failed_sources: [] }), stop('done', null, { candidates: 3, verified: 0, needs_review: 0, dropped: 3, reject_reasons: { 'dropped:stale': 3 } }), stop('failed', 'no_candidates', { failed_sources: ['search:news'], search_hits: 0 })]
  for (const v of views) { assert.equal(v.finding_more, false); assert.equal(v.next?.action, 'wider_search'); assert.doesNotMatch(v.message, /finding more/i); assert.equal(v.can_continue, true) }
  assert.equal(first5Of({ status: 'running', leads: [], progress: [], outcome: noOutcome }).finding_more, true, 'active work still says so')
})
test('PUBLICATION DATE is not the EVENT date: a lead with only a published_at keeps event_date null in the payload (never substituted)', async () => {
  const { r, jobId } = await view(fx())
  r.db.prepare("UPDATE leads SET event_date = NULL, published_at = '2026-10-01' WHERE scan_job_id = ?").run(jobId)
  const l = verifiedLeads(r.db, 'A', jobId)[0]; assert.deepEqual([l.event_date, l.published_at], [null, '2026-10-01'])
  r.db.prepare("UPDATE leads SET event_date = '2026-09-20' WHERE scan_job_id = ?").run(jobId); const l2 = verifiedLeads(r.db, 'A', jobId)[0]; assert.deepEqual([l2.event_date, l2.published_at], ['2026-09-20', '2026-10-01'])
})
test('FIRST5 makes NO post-finish TinyFish people search (real runner, tinyfish tables initialised so a missing table cannot hide it); an ordinary scan still does', async () => {
  const prev = process.env.PEOPLE_SEARCH_ENABLED; process.env.PEOPLE_SEARCH_ENABLED = '1'
  try {
    const run = async (runBudget?: string) => {
      const reqs: string[] = []
      const fetchImpl = (async (u: string) => { reqs.push(u); return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as typeof fetch
      await runFixture(fx({ runBudget, onVerify: db => migrateTinyfish(db), deps: { fetchImpl, newsHttp: async () => ({ status: 200, body: gdelt }) } }))
      return reqs.filter(u => u.startsWith('https://api.search.tinyfish.ai') && /linkedin/i.test(decodeURIComponent(u))).length
    }
    assert.equal(await run(BUDGET), 0, 'first5: zero profile-search requests after finish')
    assert.ok(await run(JSON.stringify({ paid_fallback: false, credit_enrichment: false })) >= 1, 'control: without first5 the people search does run (so the zero above is the gate, not a broken probe)')
  } finally { if (prev === undefined) delete process.env.PEOPLE_SEARCH_ENABLED; else process.env.PEOPLE_SEARCH_ENABLED = prev }
})
test('first5 budget disclosure reports TinyFish search/fetch/people search as OFF, not not_covered, and does not call model calls free', () => {
  const d = describeRunBudget({ first5: true, paid_fallback: false, credit_enrichment: false })
  const s = d.surfaces.find(x => x.surface === 'search_and_fetch')!; assert.equal(s.status, 'off'); assert.match(s.note, /not free/)
  assert.equal(describeRunBudget({ paid_fallback: false }).surfaces.find(x => x.surface === 'search_and_fetch')!.status, 'not_covered')
})
