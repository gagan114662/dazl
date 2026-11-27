import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadStatus, type ViewLead, type ViewMsg } from '../lib/outreach/campaign-view.ts'

const lead = (id: string, o: Partial<ViewLead> = {}): ViewLead => ({ id, company: id, evidence_excerpt: 'quote', confidence: 80, human_confirmed_at: null, review_reason: null, quarantined_at: null, quarantine_reason: null, ...o })
const msg = (lead_id: string, status: string, id = `m-${lead_id}`): ViewMsg => ({ id, lead_id, to_email: `${lead_id}@x.example`, subject: 'Hi', status, sent_at: null })

test('#2129 a Ready lead whose earlier email was skipped is shown as Ready, not "Email skipped"', () => {
  const s = leadStatus(lead('a', { discover_state: 'ready_email' }), [msg('a', 'skipped')])
  assert.equal(s.stage, 'qualified')
  assert.match(s.text, /^Ready - approve it to draft an email/)
  assert.match(s.text, /earlier email was skipped/i)
  assert.doesNotMatch(s.text, /^Email skipped$/)
})

test('#2129 the same holds for a source-checked lead of the older engine', () => {
  const s = leadStatus(lead('a'), [msg('a', 'skipped')])
  assert.equal(s.stage, 'qualified')
  assert.match(s.text, /^Source-checked, not drafted/)
  assert.match(s.text, /earlier email was skipped/i)
})

test('#2129 a skipped email on a lead that is not Ready shows the lead\'s own state', () => {
  assert.deepEqual(leadStatus(lead('a', { discover_state: 'research' }), [msg('a', 'skipped')]).stage, 'research')
  assert.equal(leadStatus(lead('a', { quarantined_at: 1, quarantine_reason: 'Rejected: not a fit' }), [msg('a', 'skipped')]).text, 'Rejected: not a fit')
})

test('#2129 control: other email statuses still decide the status, and an active email wins over an older skipped one', () => {
  assert.deepEqual(leadStatus(lead('a', { discover_state: 'ready_email' }), [msg('a', 'draft')]), { stage: 'draft', text: 'Draft waiting for your review' })
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'sent')]), { stage: 'sent', text: 'Sent' })
  assert.deepEqual(leadStatus(lead('a'), [msg('a', 'stopped')]), { stage: 'other', text: 'Email stopped' })
  assert.deepEqual(leadStatus(lead('a', { discover_state: 'ready_email' }), [msg('a', 'draft', 'new'), msg('a', 'skipped', 'old')]), { stage: 'draft', text: 'Draft waiting for your review' })
})

test('#2129 control: another lead\'s skipped email does not change this lead', () => {
  assert.deepEqual(leadStatus(lead('a'), [msg('b', 'skipped')]), { stage: 'qualified', text: 'Source-checked, not drafted' })
})
