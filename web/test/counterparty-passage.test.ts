// A receptionist job posting was held as "names the company as somebody else's customer". The customer-relationship check is for a HOST's own marketing page; a job board / ATS / posting
// page is the lead's hiring claim, and everyday verbs ("joining our team", "using our booking system") are not a customer relationship. Every hold also stores the exact passage that caused it.
// Stubbed pages, invented companies, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartyEvidence, counterpartySignal } from '../lib/scan/counterparty.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'

const pad = (s: string) => `${s} ${'More about the practice and its patients. '.repeat(15)}`
const cand = (company: string, url: string, excerpt = 'x') => ({ company, signal: 'is hiring a receptionist', source_url: url, excerpt, event_date: null as string | null, name: '', contact: null, score: 50 }) as never
const page = (text: string) => ({ title: 'Receptionist', text, retrievedAt: 1 }) as never

const JOB_TEXT = 'Front Desk Receptionist at Maple Dental. Indeed Posted 5 days ago. Maple Dental is joining forces with a new group and is using our booking system to welcome patients. Join our team as a receptionist.'

test('REPRODUCED: a receptionist posting on a job-board host is NOT a customer announcement by the host (it was held as somebody else\'s customer)', () => {
  for (const url of ['https://www.indeed.com/viewjob?jk=abc123', 'https://uk.indeed.com/viewjob?jk=1', 'https://www.glassdoor.co.uk/job-listing/receptionist-maple-dental-JV_1.htm', 'https://jobs.lever.co/maple-dental/abc', 'https://careers.example-board.com/jobs/receptionist-12']) {
    assert.equal(counterpartySignal(cand('Maple Dental', url), page(JOB_TEXT), ''), null, url)
  }
})
test('a real customer announcement on the HOST\'s own marketing page is still held, with the exact passage', () => {
  const text = 'Linear customer stories. Maple Dental chose Linear to run its front desk after switching from spreadsheets. ' + 'Filler text about the product. '.repeat(10)
  const hit = counterpartyEvidence(cand('Maple Dental', 'https://linear.app/customers/maple'), page(text), '')
  assert.ok(hit); assert.equal(hit!.code, 'source_owner:linear'); assert.match(hit!.passage, /Maple Dental chose Linear/); assert.ok(text.includes(hit!.passage), 'verbatim slice of the page'); assert.ok(hit!.passage.length <= 250)
})
test('the relationship phrase must sit WITH the brand and the company: a stray "using" far away on the page is not a customer relationship', () => {
  const far = 'Linear is a tool for teams. ' + 'Filler sentence about planning and roadmaps. '.repeat(30) + 'Maple Dental is using spreadsheets.'
  assert.equal(counterpartySignal(cand('Maple Dental', 'https://linear.app/blog/post'), page(far), ''), null)
})

// ---- through the real runner: the hold stores and shows its passage ----
const REQUEST = 'Find London UK dental practices hiring a receptionist.'
const ICP = { summary: 's', who: ['Owner'], industries: ['Dental'], sizes: [], where: ['London, UK'], signals: ['hiring a receptionist'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
function fx(url: string, text: string): Fixture {
  const page = { title: 'Receptionist', text: pad(`Published ${daysAgo(5)}. ${text}`) }
  const excerpt = 'Maple Dental is joining forces with a new group and is using our booking system to welcome patients'
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['london dental receptionist'], hits: [{ url, title: 'Receptionist', snippet: excerpt, date: daysAgo(5) }], tfPages: { [url]: page }, own: { [url]: page },
    extraction: [{ company: 'Maple Dental', signal: 'is hiring a receptionist', source_url: url, excerpt, event_date: daysAgo(5) }] }
}
test('END TO END: the Indeed receptionist posting is no longer held as counterparty_signal; a real customer-story page is, and its exact passage is stored beside the lead', async () => {
  const ok = await runFixture(fx('https://www.indeed.com/viewjob?jk=abc123', JOB_TEXT))
  assert.notEqual((ok.db.prepare('SELECT review_reason FROM leads').get() as { review_reason: string | null }).review_reason, 'counterparty_signal')
  const story = 'Linear customer stories. Maple Dental chose Linear after switching from spreadsheets. Maple Dental is joining forces with a new group and is using our booking system to welcome patients.'
  const bad = await runFixture(fx('https://linear.app/customers/maple', story))
  const l = bad.db.prepare('SELECT id, review_reason FROM leads').get() as { id: string; review_reason: string | null }
  assert.equal(l.review_reason, 'counterparty_signal')
  const e = enrichmentsForLeads(bad.db, 'A', [l.id])[l.id].find(x => x.kind === 'rejection')!
  assert.match(e.value, /Maple Dental chose Linear/); assert.match(e.label ?? '', /held as counterparty_signal/); assert.equal(e.connector, 'scan:rejection')
})
test('other holds store their passage too: an unconfirmed quote stores the claimed quote', async () => {
  const url = 'https://news.example/maple-opens'
  const f = fx(url, 'An unrelated article about dentistry in London. Maple Dental is mentioned once here.')
  f.extraction = [{ company: 'Maple Dental', signal: 'is hiring a receptionist', source_url: url, excerpt: 'Maple Dental is hiring two receptionists for its Soho clinic', event_date: daysAgo(5) }]
  const r = await runFixture(f); const l = r.db.prepare('SELECT id, review_reason FROM leads').get() as { id: string; review_reason: string | null }
  assert.equal(l.review_reason, 'quote_unconfirmed'); assert.match(enrichmentsForLeads(r.db, 'A', [l.id])[l.id].find(x => x.kind === 'rejection')!.value, /hiring two receptionists/)
})
