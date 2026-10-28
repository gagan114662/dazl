import { test } from 'node:test'
import assert from 'node:assert/strict'
import { barCopy, forScan, isJobId, scanCounts } from '../lib/outreach/scan-drafts.ts'

const m = (lead_id: string, status: string) => ({ lead_id, status })

test("a scan's emails are the ones drafted from its leads; another scan's are left out", () => {
  const msgs = [m('a', 'draft'), m('b', 'sent'), m('z', 'draft')]
  assert.deepEqual(forScan(msgs, ['a', 'b']), [m('a', 'draft'), m('b', 'sent')])
  assert.deepEqual(forScan(msgs, []), [])
})

test('drafts and approved-not-sent are counted apart; sent, sending, uncertain, stopped and other scans are not', () => {
  const msgs = [m('a', 'draft'), m('b', 'approved'), m('c', 'sent'), m('d', 'sending'), m('e', 'uncertain'), m('f', 'stopped'), m('z', 'draft'), m('z', 'approved')]
  assert.deepEqual(scanCounts(msgs, ['a', 'b', 'c', 'd', 'e', 'f']), { drafts: 1, approved: 1 })
  assert.deepEqual(scanCounts(msgs, ['c']), { drafts: 0, approved: 0 })
})

// Instinct #251: a saved draft was labelled "approved", and an approved email was told it needed another approval.
test('bar copy: a draft is never called approved; an approved email is never told to approve again', () => {
  assert.equal(barCopy({ drafts: 0, approved: 0 }), null)
  assert.equal(barCopy({ drafts: 1, approved: 0 }), '1 draft from this scan is waiting for your review in Outreach. Nothing is sent until you approve it there.')
  assert.equal(barCopy({ drafts: 2, approved: 0 }), '2 drafts from this scan are waiting for your review in Outreach. Nothing is sent until you approve each one there.')
  assert.equal(barCopy({ drafts: 0, approved: 1 }), '1 email from this scan is approved and not sent yet.')
  assert.equal(barCopy({ drafts: 0, approved: 3 }), '3 emails from this scan are approved and not sent yet.')
  assert.equal(barCopy({ drafts: 2, approved: 1 }), '2 drafts from this scan are waiting for your review in Outreach. Nothing is sent until you approve each one there. 1 email from this scan is approved and not sent yet.')
  for (const c of [{ drafts: 3, approved: 0 }, { drafts: 1, approved: 0 }]) assert.doesNotMatch(barCopy(c)!, /approved/, 'drafts alone never read as approved')
  assert.doesNotMatch(barCopy({ drafts: 0, approved: 2 })!, /approve (it|each)/, 'no second approval asked of approved emails')
})

test('only a scan id is accepted as the Outreach filter', () => {
  assert.equal(isJobId('b'.repeat(24)), true)
  for (const v of [null, '', 'b'.repeat(23), 'B'.repeat(24), '../x']) assert.equal(isJobId(v), false)
})
