import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trialCopy, type TrialBlock } from '../lib/trial-copy.ts'

// The trial blocks GET /api/usage returns (#410), synthetic. cap 3 is TRIAL_SCANS_PER_ACCOUNT.
const t = (o: Partial<TrialBlock>): TrialBlock => ({ funded: false, remaining: 0, cap: 3, blocked: null, ...o })

test('#410: without the trial on this deployment, any account is told it is unavailable, never what it used', () => {
  // lib/scan/trial.ts returns not_configured with used 0 / remaining 0 BEFORE reading trial_scans, so this block is the
  // same for a brand-new account and one that used trial scans earlier: the copy must claim neither "used up" nor "none".
  const fresh = trialCopy(t({ blocked: 'not_configured' }))
  assert.deepEqual([fresh.state, fresh.text], ['unavailable', "Free trial scans aren't available here right now."])
  const usedBefore = trialCopy(t({ blocked: 'not_configured', remaining: 0 })) // e.g. 3 trial scans run before the key was removed
  assert.deepEqual(usedBefore, fresh, 'identical input, identical copy')
  for (const c of [fresh, usedBefore]) assert.doesNotMatch(c.text, /used|none|of 3/)
})

test('fail-safe: not funded with no reason, or funded with nothing left, says it cannot run (not exhausted)', () => {
  for (const o of [{ funded: false, remaining: 0, blocked: null }, { funded: false, remaining: 3, blocked: undefined }, { funded: true, remaining: 0, blocked: null }]) {
    const c = trialCopy(t(o))
    assert.deepEqual([c.state, c.text], ['unavailable', "Free trial scans can't run right now."], JSON.stringify(o))
  }
})

test('each reason has its own state and wording; only real account usage reads as used up', () => {
  const row = (o: Partial<TrialBlock>) => { const c = trialCopy(t(o)); return [c.state, c.text] }
  assert.deepEqual(row({ funded: true, remaining: 2 }), ['available', '2 of 3 free trial scans left.'])
  assert.deepEqual(row({ blocked: 'account_cap' }), ['exhausted', 'You have used all 3 free trial scan attempts (failed attempts count too).'])
  assert.deepEqual(row({ blocked: 'attempts_cap' }), ['exhausted', 'You have used all 3 free trial scan attempts (failed attempts count too).'], 'attempts, not finished scans')
  assert.deepEqual(row({ blocked: 'account_total_cap', remaining: 1 }), ['exhausted', "Your free trial's allowance is used up. You have used 2 of 3 free trial scan attempts."])
  assert.deepEqual(row({ blocked: 'ip_throttle', remaining: 3 }), ['throttled', 'Too many free trial scans from your network today. Try again tomorrow. You have used 0 of 3 free trial scan attempts.'])
  assert.deepEqual(row({ blocked: 'global_daily_cap', remaining: 2 }), ['throttled', "Today's free trial scans are fully booked. Try again tomorrow (it resets at midnight UTC). You have used 1 of 3 free trial scan attempts."])
  assert.deepEqual(row({ blocked: 'google_required', remaining: 3 }), ['ineligible', 'Free trial scans are for accounts created with Google sign-in; this one signs in with a password.'])
  // a password account cannot add Google sign-in (the callback refuses an existing email): never send it there
  assert.doesNotMatch(trialCopy(t({ blocked: 'google_required' })).text, /sign in with google/i)
  assert.deepEqual(row({ blocked: 'domain_used', remaining: 3 }), ['ineligible', "Your company's email domain has already had its free trial."])
  assert.deepEqual(row({ blocked: 'something_new' }), ['unavailable', "Free trial scans can't run right now."])
  for (const b of ['not_configured', 'ip_throttle', 'global_daily_cap', 'google_required', 'domain_used', 'something_new']) {
    assert.doesNotMatch(trialCopy(t({ blocked: b, remaining: 3 })).text, /used up|used all/, `${b} is not usage`)
  }
  // Every state offers the one working next step, the account's own key; no operator value is ever in the text.
  for (const b of [null, 'not_configured', 'account_cap', 'ip_throttle', 'global_daily_cap']) {
    const c = trialCopy(t({ blocked: b, funded: b === null, remaining: b === null ? 1 : 0 }))
    assert.equal(c.next.href, '#model-key'); assert.match(c.next.label, /add your AI key/i)
    assert.doesNotMatch(c.text, /\$|sk-|usd|budget/i)
  }
})

// #410, scan start: a refused free trial (POST /api/scan) says why. Only the account's own caps read as used; a network
// throttle, a full day, an eligibility rule, an unavailable trial, a missing or unknown reason never claim past use.
test('#410 scan start: each trial refusal reason has its own true sentence and a next step', async () => {
  const { scanRefusalCopy } = await import('../lib/trial-copy.ts')
  const used = /used (all|up)/
  const cases: [Record<string, unknown>, RegExp, boolean][] = [
    [{ error: 'trial_exhausted', reason: 'account_cap', used: 3 }, /used all your free trial scan attempts/, true],
    [{ error: 'trial_unavailable', reason: 'attempts_cap' }, /used all your free trial scan attempts/, true],
    [{ error: 'trial_unavailable', reason: 'account_total_cap' }, /allowance is used up/, true],
    [{ error: 'trial_exhausted', reason: 'ip_throttle', used: 0 }, /network today\. Try again tomorrow/, false],
    [{ error: 'trial_unavailable', reason: 'global_daily_cap' }, /fully booked\. Try again tomorrow/, false],
    [{ error: 'trial_unavailable', reason: 'google_required' }, /created with Google sign-in; this one signs in with a password\. Add your AI key/, false],
    [{ error: 'trial_unavailable', reason: 'domain_used' }, /domain has already had its free trial/, false],
    [{ error: 'trial_unavailable', reason: 'not_configured' }, /can't run right now/, false],
    [{ error: 'trial_exhausted' }, /can't run right now/, false],          // an older server without a reason
    [{ error: 'trial_unavailable', reason: 'something_new' }, /can't run right now/, false],
  ]
  for (const [j, re, claimsUse] of cases) {
    const t = scanRefusalCopy(j)!
    assert.match(t, re, JSON.stringify(j))
    assert.equal(used.test(t), claimsUse, `${JSON.stringify(j)}: claims past use only for the account's own caps`)
    assert.match(t, /AI key in Settings/, 'every refusal names the step that works now')
    assert.doesNotMatch(t, /\$|budget|operator|sk-/i, 'nothing about dazl\'s keys or budgets')
    assert.doesNotMatch(t, /sign in with google/i, 'no step a password account cannot take')
    // where the key step is: first-run opens the key field right under the message
    assert.match(scanRefusalCopy(j, 'below')!, /AI key below/); assert.doesNotMatch(scanRefusalCopy(j, 'below')!, /Settings/)
  }
  for (const e of ['no_api_key', 'quota_exceeded', 'scan_active', undefined]) assert.equal(scanRefusalCopy({ error: e }), null)
})

test('#410: a trial block from /api/usage maps to the refusal the scan start would give, before a run is offered', async () => {
  const { scanRefusalCopy, trialBlockRefusal } = await import('../lib/trial-copy.ts')
  assert.deepEqual(trialBlockRefusal('ip_throttle'), { error: 'trial_exhausted', reason: 'ip_throttle' })
  assert.deepEqual(trialBlockRefusal('account_cap'), { error: 'trial_exhausted', reason: 'account_cap' })
  assert.deepEqual(trialBlockRefusal('not_configured'), { error: 'trial_unavailable', reason: 'not_configured' })
  assert.deepEqual(trialBlockRefusal('global_daily_cap'), { error: 'trial_unavailable', reason: 'global_daily_cap' })
  for (const b of [null, undefined, '', 0]) assert.equal(trialBlockRefusal(b), null, 'not blocked: nothing to say')
  assert.match(scanRefusalCopy(trialBlockRefusal('not_configured')!)!, /can't run right now/, 'unavailable, never "used"')
})
