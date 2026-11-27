// #2004: Real page dates missed by capture. Hiring signals need JobPosting.datePosted;
// non-hiring signals (expansion, funding) can use Article.datePublished. This test
// file covers both cases and validates the fix.
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLead } from '../lib/discover/check.ts'
import { discoverProofHold } from '../lib/discover/card.ts'
import { hasDiscoveryEventDate } from '../lib/discover/timing.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'

const NOW = new Date('2026-11-26T17:00:00Z')
const fetchPage = (body: string) => (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

// ============================================================================
// NON-HIRING SIGNALS: Article.datePublished IS valid evidence
// ============================================================================
const expansionUrl = 'https://resplendent.agency/opening-new-office-toronto/'
const expansionLead: DiscoveredLead = { company: 'Resplendent Agency', domain: 'resplendent.agency', signal: 'Opening a new office in Toronto', signal_date: null, evidence_url: expansionUrl, evidence_quote: 'Resplendent Agency is opening a new office in Toronto', person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'Expansion' }
const expansionHtml = (withDate: boolean) => `<html><head>${withDate ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', headline: 'Opening a new office in Toronto', datePublished: '2026-09-17T17:24:16+00:00', dateModified: '2026-09-17T17:31:48+00:00' }] })}</script>` : ''}</head><body><h1>Resplendent Agency</h1><p>We are opening a new office in Toronto.</p></body></html>`

test('NON-HIRING: Article.datePublished is page evidence for expansion signals', async () => {
  const result = await checkLead(expansionLead, [{ url: expansionUrl, title: 'Resplendent Agency expansion', page_age: '2 days ago', text: null }], fetchPage(expansionHtml(true)), 12_000, NOW)
  assert.deepEqual([result.date_source, result.date], ['page', '2026-09-17'], 'Article.datePublished should date non-hiring signals')
  assert.notEqual(result.date, '2026-11-24', 'index age should not be used')
  const discoveryLead = { event_date: result.date, timing_note: null }
  assert.equal(hasDiscoveryEventDate(discoveryLead), true)
})

// ============================================================================
// HIRING SIGNALS: ONLY JobPosting.datePosted is valid; Article.datePublished is NOT
// ============================================================================
const hiringUrl = 'https://torontodental.example/careers/dental-hygienist'
const hiringLead: DiscoveredLead = { company: 'Toronto Dental', domain: 'torontodental.example', signal: 'is hiring a Dental Hygienist', signal_date: null, evidence_url: hiringUrl, evidence_quote: 'Toronto Dental is hiring a Dental Hygienist', person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'Hiring' }
const jobPostingHtml = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dental Hygienist', datePosted: '2026-11-20T09:00:00-05:00', hiringOrganization: { '@type': 'Organization', name: 'Toronto Dental' } })}</script></head><body><h1>Toronto Dental</h1><p>We are hiring a Dental Hygienist to join our team.</p></body></html>`
const articleOnlyHtml = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: 'We are hiring', datePublished: '2026-11-20T09:00:00-05:00' })}</script></head><body><h1>Toronto Dental</h1><p>We are hiring a Dental Hygienist.</p></body></html>`
const undatedHtml = `<html><body><h1>Toronto Dental</h1><p>We are hiring a Dental Hygienist.</p></body></html>`

test('#2004 HIRING: JobPosting.datePosted is captured for a hiring signal', async () => {
  const result = await checkLead(hiringLead, [{ url: hiringUrl, title: 'Toronto Dental careers', page_age: '3 days ago', text: null }], fetchPage(jobPostingHtml), 12_000, NOW)
  // The date should come from the JobPosting.datePosted field, not the index age
  assert.deepEqual([result.date_source, result.date], ['page', '2026-11-20'], 'JobPosting.datePosted should be captured')
  assert.notEqual(result.date, '2026-11-23', 'index age should not be used when structured date exists')
  const discoveryLead = { event_date: result.date, timing_note: null }
  assert.equal(hasDiscoveryEventDate(discoveryLead), true, 'dated lead should have event date')
})

test('#2004 HIRING: Article.datePublished does NOT date hiring signals', async () => {
  // A hiring page with Article.datePublished but no JobPosting.datePosted - should NOT get a date
  const result = await checkLead(hiringLead, [{ url: hiringUrl, title: 'Toronto Dental careers', page_age: '3 days ago', text: null }], fetchPage(articleOnlyHtml), 12_000, NOW)
  // For a hiring signal, Article.datePublished is NOT sufficient - needs JobPosting.datePosted
  assert.deepEqual([result.date, result.date_source], [null, null], 'Article.datePublished should not date a hiring signal')
  const discoveryLead = { event_date: result.date, timing_note: null }
  assert.equal(hasDiscoveryEventDate(discoveryLead), false)
  assert.equal(discoverProofHold({ ...discoveryLead }), 'The signal has no date, so its timing is unknown. Open the proof to check it.')
})

test('an undated page stays held; an index age is not page date proof', async () => {
  const result = await checkLead(hiringLead, [{ url: hiringUrl, title: 'Toronto Dental careers', page_age: '3 days ago', text: null }], fetchPage(undatedHtml), 12_000, NOW)
  assert.deepEqual([result.date, result.date_source], [null, null])
  const discoveryLead = { event_date: result.date, timing_note: null }
  assert.equal(hasDiscoveryEventDate(discoveryLead), false)
  assert.equal(discoverProofHold({ ...discoveryLead }), 'The signal has no date, so its timing is unknown. Open the proof to check it.')
})
