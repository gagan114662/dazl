// The event-date-proof contract (#460) through the REAL runJob (stubbed: search, pages, model; companies INVENTED):
// verify -> persist -> read-back. A surviving event_date carries HOW it was established; an unproven date stays NULL
// and consumers fail closed. Route/counter honesty: proven-dated leads verify; an unbound claimed date goes the undated way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const proofCols = (db: import('better-sqlite3').Database) =>
  db.prepare('SELECT company, event_date, event_date_proof, event_date_proof_reason, review_reason FROM leads').all() as
    { company: string; event_date: string | null; event_date_proof: string | null; event_date_proof_reason: string | null; review_reason: string | null }[]

const FUND_REQUEST = 'Find logistics companies in Chicago that raised seed funding in the past 90 days.'
const FUND_ICP = { summary: 'Chicago logistics companies with seed funding', who: ['Founder'], industries: ['logistics'], sizes: [], where: ['Chicago'], signals: ['raised seed funding'], exclude: [], country: 'US', language: 'en' }
const QUOTE = 'Acme Logistics raised $3M in seed funding to expand its Chicago depot network'

function newsFixture(pageText: string, claim: string | null): Fixture {
  return {
    request: FUND_REQUEST, modelIcp: FUND_ICP, modelQueries: ['Chicago logistics seed funding'],
    hits: [{ url: 'https://news.example/acme-seed', title: 'Acme Logistics seed round', snippet: QUOTE, date: claim }],
    tfPages: {}, own: { 'https://news.example/acme-seed': { title: 'Acme Logistics', text: pageText } },
    extraction: [{ company: 'Acme Logistics', signal: 'raised seed funding', source_url: 'https://news.example/acme-seed', excerpt: QUOTE, event_date: claim }],
  }
}

test('page_bound: the fetched page ties the claimed day to this company and event, and the proof persists', async () => {
  const claim = daysAgo(5)
  const x = await runFixture(newsFixture(`${QUOTE} on ${claim}. The team plans to hire through the year.`, claim))
  const rows = proofCols(x.db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_date, claim)
  assert.equal(rows[0].event_date_proof, 'page_bound')
  assert.ok(rows[0].event_date_proof_reason && rows[0].event_date_proof_reason.length <= 200)
  assert.equal(rows[0].review_reason, null)
  assert.ok(Number(x.job.verified) >= 1, `counters: ${JSON.stringify(x.job)}`)
})

test('fail closed: a claimed day the page does not tie to the event is dropped with the date, proof NULL everywhere', async () => {
  const x = await runFixture(newsFixture(`${QUOTE}. The company has operated for years and serves the region.`, daysAgo(5)))
  const rows = proofCols(x.db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_date, null, 'the unbound claimed day never survives')
  assert.equal(rows[0].event_date_proof, null)
  assert.equal(rows[0].event_date_proof_reason, null)
  assert.ok(rows[0].review_reason, 'the undated lead is held for review, not verified')
})

test('ats_structured: a job board structured publish date for exactly this posting URL proves the posting day', async () => {
  const gh = 'https://boards.greenhouse.io/multi/jobs/1'
  const published = daysAgo(9)
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/multi/jobs') return j({ jobs: [{ id: 1, title: 'Front Desk Receptionist', updated_at: daysAgo(1), location: { name: 'Brooklyn, NY' }, absolute_url: gh }] })
    if (/\/jobs\/1$/.test(url)) return j({ id: 1, title: 'Front Desk Receptionist', first_published: published, content: '&lt;p&gt;Brooklyn Smiles Dental is hiring a front desk receptionist for its Brooklyn office.&lt;/p&gt;', location: { name: 'Brooklyn, NY' }, absolute_url: gh })
    return null
  }
  const quote = 'Brooklyn Smiles Dental is hiring a front desk receptionist for its Brooklyn office'
  const x = await runFixture({
    request: 'Find independent dental practices in New York City that posted a front desk receptionist job in the past 90 days.',
    modelIcp: { summary: 'NYC dental practices hiring', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['posted a front desk receptionist job'], exclude: [], country: 'US', language: 'en' },
    modelQueries: ['dental front desk receptionist job New York'],
    hits: [{ url: gh, title: 'Front Desk Receptionist', snippet: quote, date: published }],
    tfPages: {}, own: { [gh]: { title: 'Front Desk Receptionist', text: `${quote}. The practice welcomes patients every week.` } },
    extraction: [{ company: 'Brooklyn Smiles Dental', signal: 'front desk receptionist job', source_url: gh, excerpt: quote, event_date: published }],
    deps: { sourceHttp: http },
  })
  const rows = proofCols(x.db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_date, published)
  assert.equal(rows[0].event_date_proof, 'ats_structured', `row: ${JSON.stringify(rows[0])}`)
  assert.match(rows[0].event_date_proof_reason ?? '', /structured publish date/)
})
