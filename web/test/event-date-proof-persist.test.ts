// The event-date-proof contract (#460) through the REAL runJob (stubbed: search, pages, model; companies INVENTED):
// verify -> persist -> read-back. A surviving event_date carries HOW it was established; an unproven date stays NULL
// and consumers fail closed. Route/counter honesty: proven-dated leads verify; an unbound claimed date goes the undated way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const proofCols = (db: import('better-sqlite3').Database) =>
  db.prepare('SELECT company, event_date, event_date_proof, event_date_proof_note, review_reason FROM leads').all() as
    { company: string; event_date: string | null; event_date_proof: string | null; event_date_proof_note: string | null; review_reason: string | null }[]

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
  assert.ok(rows[0].event_date_proof_note && rows[0].event_date_proof_note.length <= 200)
  assert.equal(rows[0].review_reason, null)
  assert.ok(Number(x.job.verified) >= 1, `counters: ${JSON.stringify(x.job)}`)
})

test('fail closed: a claimed day the page does not tie to the event is dropped with the date, proof NULL everywhere', async () => {
  const x = await runFixture(newsFixture(`${QUOTE}. The company has operated for years and serves the region.`, daysAgo(5)))
  const rows = proofCols(x.db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_date, null, 'the unbound claimed day never survives')
  assert.equal(rows[0].event_date_proof, null)
  assert.equal(rows[0].event_date_proof_note, null)
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
  assert.match(rows[0].event_date_proof_note ?? '', /structured publish date/)
})

test('held copy: the preserved text ties the day the same way a fetched page does', async () => {
  const claim = daysAgo(5)
  const x = await runFixture({
    ...newsFixture('unused - own fetch is blocked', claim),
    own: { 'https://news.example/acme-seed': 'blocked' },
    tfPages: { 'https://news.example/acme-seed': { title: 'Acme Logistics', text: `${QUOTE} on ${claim}. The team plans to hire through the year. ${'The company serves Midwest shippers from its Chicago depot. '.repeat(6)}` } },
  })
  const rows = proofCols(x.db)
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].event_date, claim)
  assert.equal(rows[0].event_date_proof, 'page_bound')
})

test('funding negative: a job-board publish stamp never proves a funding day, even on the posting URL itself', async () => {
  const gh = 'https://boards.greenhouse.io/multi/jobs/1'
  const published = daysAgo(9)
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/multi/jobs') return j({ jobs: [{ id: 1, title: 'Front Desk Receptionist', updated_at: daysAgo(1), location: { name: 'Brooklyn, NY' }, absolute_url: gh }] })
    if (/\/jobs\/1$/.test(url)) return j({ id: 1, title: 'Front Desk Receptionist', first_published: published, content: '&lt;p&gt;Brooklyn Smiles Dental is hiring a front desk receptionist for its Brooklyn office.&lt;/p&gt;', location: { name: 'Brooklyn, NY' }, absolute_url: gh })
    return null
  }
  // The (stubbed) model cites the job posting as evidence of FUNDING - a stamp for the posting day must not launder it.
  const quote = 'Brooklyn Smiles Dental is hiring a front desk receptionist for its Brooklyn office'
  const x = await runFixture({
    request: 'Find dental practices in New York City that raised seed funding in the past 90 days.',
    modelIcp: { summary: 'NYC dental practices with seed funding', who: ['Owner'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['raised seed funding'], exclude: [], country: 'US', language: 'en' },
    modelQueries: ['dental practice seed funding New York'],
    hits: [{ url: gh, title: 'Front Desk Receptionist', snippet: quote, date: published }],
    tfPages: {}, own: { [gh]: { title: 'Front Desk Receptionist', text: `${quote}. The practice welcomes patients every week.` } },
    extraction: [{ company: 'Brooklyn Smiles Dental', signal: 'raised seed funding', source_url: gh, excerpt: quote, event_date: published }],
    deps: { sourceHttp: http },
  })
  const rows = proofCols(x.db)
  for (const r of rows) assert.notEqual(r.event_date_proof, 'ats_structured', `funding claim laundered: ${JSON.stringify(r)}`)
})

test('unknown enum: the store refuses any proof label outside the contract', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateScan } = await import('../lib/scan/store.ts')
  const db = new Database(':memory:'); migrateScan(db)
  db.exec("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('j1', 'A', 'running', 'Acme', 'x', 'y')") // the leads-insert trigger allows only a running job
  const ins = (proof: string | null, note: string | null) => () =>
    db.prepare('INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, event_date_proof, event_date_proof_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('l' + Math.random().toString(36).slice(2), 'j1', '', 'Acme', 's', 'https://x.example', 50, proof, note)
  assert.throws(ins('site_said_so', null), /CHECK/, 'a label outside the contract enum is refused')
  assert.throws(ins('page_bound', 'x'.repeat(201)), /CHECK/, 'an over-long note is refused')
  assert.doesNotThrow(ins('page_bound', 'stated in the clause of the evidence sentence that names this company'))
  assert.doesNotThrow(ins(null, null))
})

test('date validity: a malformed claimed day is never proven - it stays on the review row, unproven (anti-laundering)', async () => {
  const x = await runFixture(newsFixture(`${QUOTE}. The company has operated for years.`, '2026-13-40'))
  const rows = proofCols(x.db)
  assert.equal(rows.length, 1)
  // A day the date rules reject is deliberately LEFT as claimed and sent to review; unbinding it would launder it.
  assert.equal(rows[0].event_date, '2026-13-40')
  assert.equal(rows[0].review_reason, 'event_date_bad_date')
  assert.equal(rows[0].event_date_proof, null)
})
