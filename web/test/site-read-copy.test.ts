// Council R2-3 on d6c89bf2: what the first run says for each trial refusal of the website read matches what the code
// does (lib/scan/trial-site-read.ts): only an admitted read counts against the account's three per 30 days, a refusal
// never does, and no reason ever promises a free start or blames the user's key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siteKeyReason } from '../lib/scan/site-read-copy.ts'
import { TRIAL_SITE_READS_PER_ACCOUNT } from '../lib/scan/trial-site-read.ts'

const OWN = 'Add your own Anthropic or OpenAI key to read it, or describe your business yourself.'
test('site read reason copy: each refusal says the real reason, the account count only after admitted reads, and always offers the key and the manual profile', () => {
  assert.equal(TRIAL_SITE_READS_PER_ACCOUNT, 3)
  assert.equal(siteKeyReason('site_reads_used'), `You have used your three free website reads for now; they come back together, 30 days after the first. ${OWN}`)
  // domain_used is not "your trial is used up": another account on the company domain started it (council R3-3).
  assert.equal(siteKeyReason('domain_used'), `Another account at your company's email domain has already started the free trial, and it belongs to that account. ${OWN}`)
  assert.doesNotMatch(siteKeyReason('domain_used'), /used up/)
  assert.equal(siteKeyReason('not_configured'), `The free trial isn't available here right now. ${OWN}`)
  assert.equal(siteKeyReason('workspace_not_eligible'), `The free trial belongs to the account that created this workspace. ${OWN}`)
  assert.equal(siteKeyReason('google_required'), `The free trial needs an account that signs in with Google. ${OWN}`)
  for (const r of ['attempts_cap', 'account_cap', 'account_total_cap']) assert.equal(siteKeyReason(r), `Your free trial is used up. ${OWN}`, r)
  // Busy, throttled, out of shared money or the limiter down: "try again later", and (per lib/scan/trial-site-read.ts)
  // none of these used one of the account's reads, so the copy never says the reads are used.
  for (const r of ['ip_throttle', 'global_daily_cap', 'site_reads_busy', 'limit_unavailable']) {
    assert.equal(siteKeyReason(r), `The free trial is busy right now. Try again later. ${OWN}`, r)
    assert.doesNotMatch(siteKeyReason(r), /used your/)
  }
  // No trial reason at all (an account with its own key, or an unknown reason): the key is the way, nothing free promised.
  for (const r of [null, 'something_new']) { assert.equal(siteKeyReason(r), 'Reading your site runs on your own Anthropic or OpenAI key.'); assert.doesNotMatch(siteKeyReason(r), /free/) }
  // Nothing the first run shows reads as a free-start promise (the UI check refuses these phrases on the whole step).
  for (const r of ['site_reads_used', 'domain_used', 'not_configured', 'site_reads_busy']) assert.doesNotMatch(siteKeyReason(r), /free search|free scans? to start|3 free/i)
})
