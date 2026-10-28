import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forScan, isJobId, waitingCount } from '../lib/outreach/scan-drafts.ts'

const m = (lead_id: string, status: string) => ({ lead_id, status })

test("a scan's emails are the ones drafted from its leads; another scan's are left out", () => {
  const msgs = [m('a', 'draft'), m('b', 'sent'), m('z', 'draft')]
  assert.deepEqual(forScan(msgs, ['a', 'b']), [m('a', 'draft'), m('b', 'sent')])
  assert.deepEqual(forScan(msgs, []), [])
})

test('the bar counts only emails still waiting on the user: drafts and approved-not-sent', () => {
  const msgs = [m('a', 'draft'), m('b', 'approved'), m('c', 'sent'), m('d', 'sending'), m('e', 'uncertain'), m('f', 'stopped'), m('z', 'draft')]
  assert.equal(waitingCount(msgs, ['a', 'b', 'c', 'd', 'e', 'f']), 2)
  assert.equal(waitingCount(msgs, ['c']), 0)
})

test('only a scan id is accepted as the Outreach filter', () => {
  assert.equal(isJobId('b'.repeat(24)), true)
  for (const v of [null, '', 'b'.repeat(23), 'B'.repeat(24), '../x']) assert.equal(isJobId(v), false)
})
