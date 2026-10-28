// Finish unfinished candidates before they are returned held (modelled on scan 6: Embedd = no event date, Querio = no sales-hiring evidence). SYNTHETIC pages and boards through the
// real runner / verifier / window gate / sales-hiring gate: no network, no key, no credits. Nothing here loosens a gate: a date found this way is judged by the same window gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { resolveStructuredDate, kindsFor } from '../lib/scan/structured-date.ts'
import { applySalesHiringGate } from '../lib/scan/sales-hiring-gate.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const REQUEST = 'Find London UK B2B startups that opened a new office within the past 90 days.'
const ICP = { summary: 'London B2B startups', who: ['Founder'], industries: ['software'], sizes: [], where: ['London, UK'], signals: ['opened a new office'], exclude: [], window_days: 90 }
const filler = ' The team builds developer tooling for London engineering teams and welcomes visitors every week.'.repeat(6)
const URL = 'https://news.example/embedd-office'
const QUOTE = 'Embedd opened a new office in Shoreditch, London for its growing engineering team'
const ld = (o: object) => JSON.stringify(o)
const EVENT = (startDate: string, organizer = 'Embedd') => ld({ '@context': 'https://schema.org', '@type': 'Event', name: 'Office opening', startDate, organizer: { '@type': 'Organization', name: organizer } })
function fx(structured: string[] | undefined, over: { published?: string; quote?: string } = {}): Fixture {
  const c: Cand = { company: 'Embedd', signal: 'opened a new London office', source_url: URL, excerpt: over.quote ?? QUOTE, event_date: null }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['london startup opens office'], hits: [{ url: URL, title: 'Embedd', snippet: QUOTE, date: null }], tfPages: {},
    own: { [URL]: { title: 'Embedd opens in Shoreditch', text: `${over.quote ?? QUOTE}.${filler}`, ...(over.published ? { published: over.published } : {}), ...(structured ? { structured } : {}) } }, extraction: [c] }
}
const row = async (f: Fixture) => { const x = await runFixture(f); return { x, r: x.db.prepare('SELECT event_date, review_reason, timing_note FROM leads').get() as { event_date: string | null; review_reason: string | null; timing_note: string | null } } }

test('EMBEDD: an undated candidate whose page declares an in-window Event startDate for Embedd is finished, judged by the window gate, and qualifies', async () => {
  const { r } = await row(fx([EVENT(daysAgo(9))]))
  assert.equal(r.review_reason, null, JSON.stringify(r)); assert.equal(r.event_date, daysAgo(9)); assert.match(r.timing_note ?? '', /structured data \(schema\.org Event\), not from the quote/)
})
test('EMBEDD: nothing found -> stays held with the specific reason (outside_window_undated), no date invented', async () => {
  for (const structured of [undefined, [], ['{not json']]) {
    const { r } = await row(fx(structured))
    assert.equal(r.review_reason, 'outside_window_undated'); assert.equal(r.event_date, null)
  }
})
test('the window gate still applies to a structured date: stale or future dates are held with their own reason', async () => {
  assert.equal((await row(fx([EVENT(daysAgo(200))]))).r.review_reason, 'outside_window')
  assert.equal((await row(fx([EVENT(daysAgo(-40))]))).r.review_reason, 'event_date_future_date')
})
test('identity: an Event organised by another company, a publication/modified stamp, two different dates, or a JobPosting date on an opening claim never date the lead', async () => {
  for (const structured of [
    [EVENT(daysAgo(9), 'Initech')],
    [ld({ '@type': 'NewsArticle', headline: 'Embedd office', datePublished: daysAgo(9), dateModified: daysAgo(3) })],
    [EVENT(daysAgo(9)), EVENT(daysAgo(30))],
    [ld({ '@type': 'JobPosting', title: 'Engineer', datePosted: daysAgo(9), hiringOrganization: { '@type': 'Organization', name: 'Embedd' } })],
  ]) { const { r } = await row(fx(structured)); assert.equal(r.review_reason, 'outside_window_undated', structured[0]); assert.equal(r.event_date, null) }
})
test('resolveStructuredDate: @graph and nested nodes are read; kind must fit the claim; one distinct date only', () => {
  const g = ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Thing', 'BusinessEvent'], name: 'Embedd launch', startDate: '2026-10-01T09:00:00+01:00' }] })
  assert.deepEqual(resolveStructuredDate([g], 'Embedd Ltd', 'opened a new office'), { date: '2026-10-01', kind: 'Event' })
  assert.equal(resolveStructuredDate([g], 'Embedd', 'raised a seed round'), null, 'a funding claim is never dated by an Event')
  const jp = ld({ '@type': 'JobPosting', datePosted: '2026-10-02', hiringOrganization: { name: 'Embedd' } })
  assert.deepEqual(resolveStructuredDate([jp], 'Embedd', 'is hiring an account executive'), { date: '2026-10-02', kind: 'JobPosting' })
  assert.equal(resolveStructuredDate([jp], 'Embedd', 'opened a new office'), null)
  assert.equal(resolveStructuredDate([ld({ '@type': 'Event', name: 'Embedd', startDate: '2026-02-30' })], 'Embedd', 'opened'), null, 'not a real calendar day')
  assert.deepEqual(kindsFor('raised a seed round'), [])
})
test('bounded: at most 6 undated candidates are finished per scan', async () => {
  const { finishUndatedLeads } = await import('../lib/scan/structured-date.ts')
  const leads = Array.from({ length: 9 }, (_, i) => ({ company: 'Embedd', signal: 'opened a new office', excerpt: 'x', source_url: `https://e.example/${i}`, event_date: null as string | null }))
  let fetched = 0
  const done = await finishUndatedLeads(leads, async () => { fetched++; return { structured: [EVENT('2026-10-20')] } })
  assert.equal(fetched, 6); assert.equal(done.length, 6); assert.equal(leads.filter(l => l.event_date).length, 6)
})

// ---- QUERIO: no verified sales-hiring evidence. The gate's own enrichment (ATS board + careers page) decides; same gate, stubbed boards. ----
const NOW = Date.parse('2026-10-28T12:00:00Z')
const dIso = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const SEED_REQ = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const SEED_ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [] })
function querio() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(SEED_REQ, SEED_ICP, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, date_status) VALUES ('L1', ?, '', 'Querio', 'querio.ai', 'raised a seed round', 'https://news.example/querio', 'Querio, a London analytics startup, raised a 3m GBP seed round this month', 80, 70, 'w', ?, 'unverified')").run(jobId, dIso(12).slice(0, 10))
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'L1', 'u1', 'sitecrawl', 'domain', 'querio.ai|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 90, 'https://news.example/querio', '2026-10-20', 10)").run()
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 1, needs_review = 0 WHERE id = ?").run(jobId)
  return { db, job: { id: jobId, user_id: 'u1', query: SEED_REQ, icp: SEED_ICP } }
}
const GH = 'https://boards-api.greenhouse.io/v1/boards/querio'
const serve = (m: Record<string, unknown>) => (async (u: RequestInfo | URL) => (m[String(u)] ? new Response(JSON.stringify(m[String(u)]), { status: 200 }) : new Response('nope', { status: 404 }))) as never
test('QUERIO: its public Greenhouse board lists a dated London sales posting bound to querio.ai -> it keeps its place (qualifies on that evidence)', async () => {
  const { db, job } = querio()
  const r = await applySalesHiringGate(db, job, serve({ [`${GH}/jobs`]: { jobs: [{ id: 7, title: 'Account Executive' }] }, [`${GH}/jobs/7`]: { id: 7, title: 'Account Executive', first_published: dIso(10), absolute_url: 'https://boards.greenhouse.io/querio/jobs/7', location: { name: 'London, UK' }, content: '&lt;p&gt;Querio is hiring. Write to jobs@querio.ai&lt;/p&gt;' } }), { now: NOW })
  assert.equal(r.passed, 1); assert.equal((db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason, null)
})
test('QUERIO: nothing found on any board or careers page -> stays held with the specific reason no_sales_hiring_evidence', async () => {
  const { db, job } = querio()
  const r = await applySalesHiringGate(db, job, serve({}), { now: NOW })
  assert.equal(r.demoted, 1); assert.equal((db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason, 'no_sales_hiring_evidence')
})
