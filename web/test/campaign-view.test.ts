import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadStatus, scanMessages, type ViewLead, type ViewMsg } from '../lib/outreach/campaign-view.ts'

const lead = (id: string, o: Partial<ViewLead> = {}): ViewLead => ({ id, company: id, evidence_excerpt: 'quote', confidence: 80, human_confirmed_at: null, review_reason: null, quarantined_at: null, quarantine_reason: null, ...o })
const msg = (lead_id: string, status: string): ViewMsg => ({ id: `m-${lead_id}`, lead_id, to_email: `${lead_id}@x.example`, subject: 'Hi', status, sent_at: null })

test('a lead with an email: the email decides (draft, approved-not-sent, sending, unknown outcome, sent)', () => {
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'draft')]), { stage: 'draft', text: 'Draft waiting for your review' })
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'approved')]), { stage: 'approved', text: 'Approved, not sent yet' })
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'uncertain')]), { stage: 'sending', text: 'Send outcome unknown - check Outreach' })
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'sent')]), { stage: 'sent', text: 'Sent' })
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'stopped')]), { stage: 'other', text: 'Email stopped' })
})

test('without an email: rejected, then review, then evidence state; never "verified" for an unverified lead', () => {
  assert.deepEqual(leadStatus(lead('a', { quarantined_at: 1, quarantine_reason: 'Rejected: not a fit' }), [msg('a', 'draft')]), { stage: 'rejected', text: 'Rejected: not a fit' }, 'a rejection wins over a stale draft')
  assert.equal(leadStatus(lead('a', { quarantined_at: 1, quarantine_reason: null }), []).text, 'Rejected')
  assert.deepEqual(leadStatus(lead('a', { review_reason: 'no_quote' }), []), { stage: 'review', text: 'Needs your review' })
  assert.deepEqual(leadStatus(lead('a'), []), { stage: 'qualified', text: 'Source-checked, not drafted' })
  assert.deepEqual(leadStatus(lead('a', { evidence_excerpt: null, human_confirmed_at: 5 }), []), { stage: 'qualified', text: 'Confirmed by you, not drafted' })
  assert.deepEqual(leadStatus(lead('a', { evidence_excerpt: null }), []), { stage: 'unverified', text: 'Not verified - check the source' }, 'legacy row with a confidence but no excerpt')
})

test("only this scan's emails are listed", () => {
  assert.deepEqual(scanMessages([msg('a', 'draft'), msg('z', 'sent'), msg('b', 'sent')], [lead('a'), lead('b')]).map(m => m.lead_id), ['a', 'b'])
  assert.deepEqual(scanMessages([msg('z', 'sent')], []), [])
})
