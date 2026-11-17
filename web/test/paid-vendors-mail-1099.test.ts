// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. Tests of the vendor code paths opt in (test/paid-vendors-on.ts),
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
// Part of the #1273 split: the work-email / mailbox-check gates.
import test from 'node:test'
import assert from 'node:assert/strict'
import { verifierFromEnv } from '../lib/people/email-pattern.ts'

const OFF = { DAZL_PAID_VENDORS: '' }

test('mailbox check: a ZeroBounce key is not used unless named', () => {
  assert.equal(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'zb-key', ...OFF }), null)
  assert.ok(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'zb-key', DAZL_PAID_VENDORS: 'zerobounce' }))
})
