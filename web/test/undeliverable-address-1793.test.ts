import test from 'node:test'
import assert from 'node:assert/strict'
import { undeliverableAddress } from '../lib/outreach/undeliverable-address.ts'

test('undeliverable role mailboxes are blocked case-insensitively and after plus-tag stripping', () => {
  const blocked = [
    'no-reply@x.test', 'No-Reply@X.test', 'noreply@x.test', 'NoReply@X.test',
    'do-not-reply@x.test', 'DO-NOT-REPLY+tag@x.test', 'donotreply@x.test',
    'mailer-daemon@x.test', 'MAILER-DAEMON@x.test', 'mailerdaemon@x.test',
    'postmaster@x.test', 'bounce@x.test', 'bounces@x.test',
    'unsubscribe@x.test', 'notifications@x.test', 'notification@x.test',
    'noreply+abc@x.com', 'mailer-daemon+campaign@x.test',
  ]
  for (const email of blocked) assert.equal(undeliverableAddress(email).blocked, true, email)
})

test('human role and personal-looking addresses remain deliverable; malformed input is safe', () => {
  for (const email of ['info@x.test', 'sales@x.test', 'jane.doe@x.test', 'ordinary+tag@x.test', '', ' ', 'not-an-email', '@x.test', 'user@'])
    assert.equal(undeliverableAddress(email).blocked, false, email)
  assert.equal(typeof undeliverableAddress('noreply@x.test').reason, 'string')
})
