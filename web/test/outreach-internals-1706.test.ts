// #1706 (Outreach slice): the sequences UI spoke in operator words (site operator, kill switch, a test-inbox
// allowlist panel on the production page) and told the sending story three different ways. These checks pin
// the customer-facing surface: no operator vocabulary, the test panel behind the same staging gate as the
// test fixtures, and one approval-first account of when steps 2 and 3 send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/app/outreach/sequences-client.tsx', import.meta.url), 'utf8')

test('#1706 the sequences page never speaks in operator words', () => {
  assert.doesNotMatch(src, /site operator/i, 'no site operator')
  assert.doesNotMatch(src, /kill switch/i, 'no kill switch')
  assert.doesNotMatch(src, /operator switch/i, 'no operator switch')
  assert.doesNotMatch(src, /operator-designated/, 'no operator-designated accounts')
})

test('#1706 the test inbox panel renders only for the designated test account (Qodo, corrected by Capy)', () => {
  // Capy on PR #1759: gating the editor on fixtureAvailable (which requires the inbox to be
  // allowlisted already) makes setup impossible, and the saved-inboxes panel promised minute
  // follow-ups to ordinary accounts, whose sends use day gaps. Both now gate on eligibility —
  // the server-checked designated test account, before anything is allowlisted.
  assert.match(src, /\{fixtureEligible&&<details/, 'the editor is gated on server-checked test-account eligibility, not availability and not the staging flag')
  assert.doesNotMatch(src, /NEXT_PUBLIC_DAZL_STAGING==='1'&&<details/, 'the staging flag alone no longer shows the panel — staging is customer-reachable')
  assert.match(src, /Test inbox allowlist/, 'the panel itself is unchanged for the test account')
  assert.match(src, /\{fixtureEligible&&data&&data\.test_addresses\.length>0/, 'the saved-inboxes panel shows only to the designated account')
  assert.match(src, /data-testid="test-addresses-saved"/, 'the designated account with saved test inboxes sees that they exist')
  assert.match(src, /Remove all test inboxes/, 'and can remove them')
  assert.match(src, /action:'test_addresses',addresses:\[\]/, 'removal saves the empty list through the existing action')
})

test('#1706 one sending story: the approval claim is scoped to sequences you create, and the automatic path is named as the exception', () => {
  assert.match(src, /For a sequence you create here, you approve every word of all three steps before anything sends/, 'the explainer scopes the approval claim to sequences the user creates')
  assert.doesNotMatch(src, /summary="You approve every word of all three steps before anything sends/, 'the old unconditional claim is gone: the autopilot path sends without that review (Qodo/Ziggy on #1759)')
  assert.match(src, /Automatic sequences are the exception/, 'the explainer names the automatic path as the exception')
  assert.match(src, /starts a sequence by itself, without this review/, 'and says plainly that it starts without the word-by-word review')
  assert.doesNotMatch(src, /steps 2 and 3 send automatically unless someone replies/, 'the old automatic-first summary is gone')
  assert.doesNotMatch(src, /Add the test inbox to the allowlist above first/, 'the old allowlist error copy is gone')
  assert.match(src, /Scheduled sending is paused right now/, 'a paused scheduler is stated in plain words')
})
