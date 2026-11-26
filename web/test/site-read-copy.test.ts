// Council R2-3 on d6c89bf2: what the first run says for each trial refusal of the website read matches what the code
// does (lib/scan/trial-site-read.ts): only an admitted read counts against the account's three per 30 days, a refusal
// never does, and no reason ever promises a free start. #1703: no line offers a key of the user's own - the way on is
// the manual profile (or Link Google, which first-run shows beside this text), pinned here for every case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siteReadReason } from '../lib/scan/site-read-copy.ts'
import { TRIAL_SITE_READS_PER_ACCOUNT } from '../lib/scan/trial-site-read.ts'

const MANUAL = 'Describe your business yourself below.'
const EVERY = [null, 'not_configured', 'not_in_allowlist', 'site_reads_used', 'workspace_not_eligible', 'google_required', 'domain_used', 'account_total_cap', 'attempts_cap', 'account_cap', 'ip_throttle', 'global_daily_cap', 'site_reads_busy', 'limit_unavailable', 'spend_unavailable', 'read_failed', 'a_reason_not_known_yet'] as const

test("site read reason copy: each refusal says the real reason, the account count only after admitted reads, and always the manual profile, never a key of the user's own", () => {
  assert.equal(TRIAL_SITE_READS_PER_ACCOUNT, 3)
  assert.equal(siteReadReason('site_reads_used'), `You have used your three free website reads for now; they come back together, 30 days after the first. ${MANUAL}`)
  // domain_used is not "your trial is used up": another account on the company domain started it (council R3-3).
  assert.equal(siteReadReason('domain_used'), `Another account at your company's email domain has already started the free trial, and it belongs to that account. ${MANUAL}`)
  assert.doesNotMatch(siteReadReason('domain_used'), /used up/)
  assert.equal(siteReadReason('not_configured'), `The free trial isn't available here right now. ${MANUAL}`)
  assert.equal(siteReadReason('workspace_not_eligible'), `The free trial belongs to the account that created this workspace. ${MANUAL}`)
  assert.equal(siteReadReason('google_required'), `Free website reads need a Google account: link Google to this account to read it free (no card). ${MANUAL}`)
  for (const r of ['attempts_cap', 'account_cap']) assert.equal(siteReadReason(r), `Your free trial is used up. ${MANUAL}`, r)
  // The money ceiling names the reads (council round 3): the same note lib/trial-copy.ts gives the usage line.
  assert.equal(siteReadReason('account_total_cap'), `Your free trial's spending allowance is used up (website reads on the trial count toward it). ${MANUAL}`)
  // Busy, throttled, out of shared money or the limiter down: "try again later", and (per lib/scan/trial-site-read.ts)
  // none of these used one of the account's reads, so the copy never says the reads are used.
  for (const r of ['ip_throttle', 'global_daily_cap', 'site_reads_busy', 'limit_unavailable']) {
    assert.equal(siteReadReason(r), `The free trial is busy right now. Try again later. ${MANUAL}`, r)
    assert.doesNotMatch(siteReadReason(r), /used your/)
  }
  // The read's own spend guard refused before any call: nothing was used up, and the copy says so (the port's
  // 'spend_unavailable' refusal, lib/scan/icp-from-site.ts).
  assert.equal(siteReadReason('spend_unavailable'), `The free trial could not fund this read just now; nothing was used up. Try again later. ${MANUAL}`)
  assert.doesNotMatch(siteReadReason('spend_unavailable'), /used your/)
  // A funded read that failed DID count: the reason says it failed and what a retry costs, never "nothing used".
  assert.equal(siteReadReason('read_failed'), `dazl's free trial could not read your site just now; that read counted toward your three. Trying the read again uses another. ${MANUAL}`)
  assert.doesNotMatch(siteReadReason('read_failed'), /nothing was used/)
  // No reason given, or one this screen does not know yet: the read cannot run, so it says that and points at the
  // profile below - nothing free is promised, no key is asked for, and no use is claimed.
  for (const r of [null, 'something_new']) {
    assert.equal(siteReadReason(r), 'The automatic read is unavailable. Describe your business yourself below.')
    assert.doesNotMatch(siteReadReason(r), /free/)
  }
  // #1703: no refusal, and no fallback, ever offers a key of the user's own (BYOK is retired).
  for (const r of EVERY) assert.doesNotMatch(siteReadReason(r), /AI key|your key|own key|Anthropic key|model-key|bring your own/i, String(r))
  // Every refusal still offers the manual profile (the UI check refuses the key and free-start phrases on the whole step).
  for (const r of EVERY) assert.ok(siteReadReason(r).endsWith(MANUAL), `${r}: the manual profile stays the way on`)
  // Nothing the first run shows reads as a free-start promise.
  for (const r of ['site_reads_used', 'domain_used', 'not_configured', 'site_reads_busy']) assert.doesNotMatch(siteReadReason(r), /free search|free scans? to start|3 free/i)
})
