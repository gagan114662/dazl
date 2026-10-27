import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approveState, leadCardSummary } from '../lib/scan/lead-card.ts'
import type { CardLead } from '../lib/scan/opportunity.ts'

const base: CardLead = {
  id: 'a'.repeat(24), company: 'Bright Dental', signal: 'Bright Dental opened a second office in Dublin, OH', source_url: 'https://www.news.example/bright',
  evidence_excerpt: 'Bright Dental opened a second office', event_date: '2026-10-01', date_status: 'unverified', review_reason: null,
  fit: 4, intent: 3, why: 'Two-location practice that matches your dental owner profile. It also hired staff.', icp_match: null,
  company_domain: 'brightdental.example', contact: 'hello@brightdental.example', confidence: 80, human_confirmed_at: null,
  enrichments: [],
}

test('the card shows company, contact, one line of why, source host and the claimed date', () => {
  const s = leadCardSummary(base)
  assert.equal(s.company, 'Bright Dental')
  assert.equal(s.contact, 'hello@brightdental.example')
  assert.equal(s.why, 'Two-location practice that matches your dental owner profile.')
  assert.equal(s.sourceHost, 'news.example')
  assert.equal(s.date, 'claimed event date 2026-10-01')
  assert.deepEqual(s.approve, { ok: true })
})

test('without a rationale the why line is the saved signal claim; unknowns stay unknown', () => {
  const s = leadCardSummary({ ...base, why: null, contact: null, event_date: null })
  assert.equal(s.why, base.signal)
  assert.equal(s.contact, null)
  assert.equal(s.date, 'event date unknown')
})

test('Approve is offered only when every existing draft condition holds', () => {
  const blocked = (l: Partial<CardLead>) => { const a = approveState({ ...base, ...l }); return a.ok ? null : a.reason }
  assert.match(blocked({ quarantined_at: 1 })!, /Rejected/)
  assert.match(blocked({ review_reason: 'quote_unconfirmed' })!, /could not confirm/)
  assert.match(blocked({ window_held: true })!, /time window/)
  assert.match(blocked({ confidence: null, human_confirmed_at: null })!, /Not verified/)
  assert.match(blocked({ fit: 0, intent: null })!, /not a fit/)
  assert.match(blocked({ contact: null })!, /No published email/)
  assert.match(blocked({ contact: 'privacy@brightdental.example' })!, /No published email/)
  assert.match(blocked({ currentness_held: true })!, /timing is unknown/)
  assert.equal(blocked({ confidence: null, human_confirmed_at: 1700000000 }), null, 'a lead you confirmed can be approved')
})
