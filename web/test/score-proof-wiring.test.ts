// Consumer-level wiring proof for the #377/#378 contract (B's draft, adapted to the acceptance harness so the
// REAL runJob chain runs: search -> extraction -> verification -> persist -> read-back). A page that binds the
// claimed day to this company and this event persists page_bound; a publication stamp on the page proves
// nothing about the event, so the lead fails closed (date and proof both dropped).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo } from './helpers/acceptance-harness.ts'

test('a page that binds the claimed date to this company and this event persists page_bound; a publication stamp does not', async () => {
  const day = daysAgo(5)
  // The binder accepts the day in the quote's own company-naming clause; a separate restating sentence with an inflected verb stays unbound (conservative, reported for review).
  const BOUND = `Acme Dental said it will open a second clinic in Toronto on ${day}. The expansion adds six chairs.`
  const STAMPED = `Published ${day}. Beta Dental said it will open a second clinic in Toronto. The expansion adds six chairs and two hygienists to the team.`
  const x = await runFixture({
    request: 'Dental clinics in Toronto opening a new location',
    modelIcp: { summary: 'Toronto dental clinics expanding', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['Toronto'], signals: ['opening a new location'], exclude: [], country: 'CA', language: 'en' },
    modelQueries: ['dental clinic second location Toronto'],
    hits: [
      { url: 'https://news.example.com/acme', title: 'Acme Dental expansion', snippet: 'Acme Dental said it will open a second clinic in Toronto', date: day },
      { url: 'https://news.example.com/beta', title: 'Beta Dental expansion', snippet: 'Beta Dental said it will open a second clinic in Toronto', date: day },
    ],
    tfPages: {},
    own: {
      'https://news.example.com/acme': { title: 'Acme Dental', text: BOUND },
      'https://news.example.com/beta': { title: 'Beta Dental', text: STAMPED },
    },
    extraction: [
      { company: 'Acme Dental', signal: 'Opening a second Toronto clinic', source_url: 'https://news.example.com/acme', excerpt: 'Acme Dental said it will open a second clinic in Toronto', event_date: day },
      { company: 'Beta Dental', signal: 'Opening a second Toronto clinic', source_url: 'https://news.example.com/beta', excerpt: 'Beta Dental said it will open a second clinic in Toronto', event_date: day },
    ],
  })
  const rows = x.db.prepare('SELECT company, event_date, event_date_proof FROM leads ORDER BY company').all() as { company: string; event_date: string | null; event_date_proof: string | null }[]
  const acme = rows.find(r => r.company === 'Acme Dental')!
  const beta = rows.find(r => r.company === 'Beta Dental')!
  assert.equal(acme.event_date, day)
  assert.equal(acme.event_date_proof, 'page_bound', 'the fetched page ties the claimed day to this company and this event')
  assert.equal(beta.event_date_proof, null, 'a publication stamp dates the page, never the event')
  assert.equal(beta.event_date, null, 'the unbound claim is treated as undated (existing honest behavior preserved)')
})
