import assert from 'node:assert/strict'
import test from 'node:test'
import { composeDraftCopy } from '../lib/outreach/draft-copy.ts'

const samples = [
  { trade: 'dentist', name: 'Dana Ruiz', company: 'Fern Dental', signal: 'Fern Dental posted a dental hygienist opening', offer: 'Sterilization equipment for dental clinics', pitch: 'sterilization equipment for dental clinics', internal: 'accounting_uncertain' },
  { trade: 'commercial cleaning', name: 'Sam Reed', company: 'Clearway Cleaning', signal: 'Clearway Cleaning opened a second branch', offer: 'Scheduling software for cleaning crews', pitch: 'scheduling software for cleaning crews', internal: 'HTTP 503 Service Unavailable' },
  { trade: 'B2B SaaS hiring SDRs', name: 'Jo Chen', company: 'Northstar Software', signal: 'Northstar Software posted two SDR openings', offer: 'Train first-time sales development managers', pitch: 'train first-time sales development managers', internal: 'evidence_excerpt: copied from the record' },
  { trade: 'marketing agency', name: 'Alex Bell', company: 'Harbor Creative', signal: 'Harbor Creative opened a new studio', offer: 'Production support for creative teams', pitch: 'production support for creative teams', internal: '{"review_reason":"source_review_required"}' },
  { trade: 'local trades', name: 'Riley Shah', company: 'Juniper Plumbing', signal: 'Juniper Plumbing added an emergency service team', offer: 'Dispatch tools for plumbing businesses', pitch: 'dispatch tools for plumbing businesses', internal: 'Saved excerpt from this public page: trace output' },
] as const

const systemCopy = /accounting_uncertain|HTTP\s+503|evidence_excerpt|review_reason|source_review_required|Saved excerpt|contact address published|About [^:]+:|[{}]|https?:\/\//i

for (const sample of samples) {
  test(`server test: ${sample.trade} draft uses its own offer and leaves out system copy`, () => {
    const lead = {
      name: sample.name, company: sample.company, signal: sample.signal, confidence: 90,
      evidence_excerpt: `${sample.signal}\n${sample.internal}`,
      event_date: '2025-11-12', event_date_proof: 'page_bound',
    }
    const { subject, body } = composeDraftCopy(lead, 'Example Sender', `${sample.offer}\n${sample.internal}`)
    assert.doesNotMatch(subject + '\n' + body, systemCopy)
    assert.ok(body.startsWith(`Hi ${sample.name.split(' ')[0]},\n`), body)
    assert.ok(body.includes(`November 12, 2025, ${sample.signal}.`), body)
    assert.ok(body.toLowerCase().includes(sample.pitch), body)
    for (const other of samples.filter(other => other !== sample)) {
      assert.ok(!body.toLowerCase().includes(other.pitch), body)
    }
    assert.doesNotMatch(body, /sales-automation SaaS|small marketing agencies/i)
    assert.ok(body.trim().split(/\s+/).length <= 120, body)
  })
}

test('server test: diagnostic-only names and evidence use neutral copy', () => {
  const { subject, body } = composeDraftCopy({
    name: 'accounting_uncertain',
    confidence: 90,
    evidence_excerpt: '{"review_reason":"source_review_required"}',
    event_date: '2025-11-12',
    event_date_proof: 'page_bound',
  }, 'Example Sender', 'Scheduling software for cleaning crews')
  assert.equal(subject, 'Quick question for you')
  assert.match(body, /^Hi there,\n/)
  assert.doesNotMatch(body, systemCopy)
  assert.doesNotMatch(body, /November 12/)
})
