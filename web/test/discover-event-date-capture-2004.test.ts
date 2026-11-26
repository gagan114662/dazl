import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLead } from '../lib/discover/check.ts'
import { discoverProofHold } from '../lib/discover/card.ts'
import { hasDiscoveryEventDate } from '../lib/discover/timing.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'

const NOW = new Date('2026-11-26T17:00:00Z')
const URL = 'https://resplendent.agency/were-hiring-social-media-intern-fall/'
const lead: DiscoveredLead = { company: 'Resplendent Agency', domain: 'resplendent.agency', signal: 'Hiring a Social Media Intern', signal_date: null, evidence_url: URL, evidence_quote: "We're Hiring: Social Media Intern (Fall)", person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'Hiring' }
const html = (withDate: boolean) => `<html><head>${withDate ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', headline: "We're Hiring: Social Media Intern (Fall)", datePublished: '2026-09-17T17:24:16+00:00', dateModified: '2026-09-17T17:31:48+00:00' }] })}</script>` : ''}</head><body><h1>Resplendent Agency</h1><p>We're Hiring: Social Media Intern (Fall)</p></body></html>`
const fetchPage = (body: string) => (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

test('Resplendent Article graph datePublished is page evidence, never the search-index date', async () => {
  const result = await checkLead(lead, [{ url: URL, title: 'Resplendent Agency hiring', page_age: '2 days ago', text: null }], fetchPage(html(true)), 12_000, NOW)
  assert.deepEqual([result.date_source, result.date], ['page', '2026-09-17'])
  assert.notEqual(result.date, '2026-11-24')
  assert.equal(result.date_on_page, false)
  const discoveryLead = { event_date: result.date, timing_note: null }
  assert.equal(hasDiscoveryEventDate(discoveryLead), true)
  assert.notEqual(discoverProofHold({ ...discoveryLead }), 'The event date is unconfirmed. Research only.')
})

test('an undated page stays held; an index age is not page date proof', async () => {
  const result = await checkLead(lead, [{ url: URL, title: 'Resplendent Agency hiring', page_age: '2 days ago', text: null }], fetchPage(html(false)), 12_000, NOW)
  assert.deepEqual([result.date, result.date_source], [null, null])
  const discoveryLead = { event_date: result.date, timing_note: null }
  assert.equal(hasDiscoveryEventDate(discoveryLead), false)
  assert.equal(discoverProofHold({ ...discoveryLead }), 'The signal has no date, so its timing is unknown. Open the proof to check it.')
})
