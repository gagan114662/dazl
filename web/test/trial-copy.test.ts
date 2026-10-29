import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trialCopy, type TrialBlock } from '../lib/trial-copy.ts'

// The trial blocks GET /api/usage returns (#410), synthetic. cap 3 is TRIAL_SCANS_PER_ACCOUNT.
const t = (o: Partial<TrialBlock>): TrialBlock => ({ funded: false, remaining: 0, cap: 3, blocked: null, ...o })

test('#410: a fresh account on a deployment without the trial is told it is unavailable, never that it used three', () => {
  // lib/scan/trial.ts trialStatus with no operator key: funded false, reason not_configured, used 0, remaining 0.
  const c = trialCopy(t({ blocked: 'not_configured' }))
  assert.equal(c.state, 'unavailable')
  assert.equal(c.text, "Free trial scans aren't available here right now, so none have been used.")
  assert.doesNotMatch(c.text, /used up|of 3/)
})

test('each reason has its own state and wording; only real account usage reads as used up', () => {
  const row = (o: Partial<TrialBlock>) => { const c = trialCopy(t(o)); return [c.state, c.text] }
  assert.deepEqual(row({ funded: true, remaining: 2 }), ['available', '2 of 3 free trial scans left.'])
  assert.deepEqual(row({ blocked: 'account_cap' }), ['exhausted', 'Your 3 free trial scans are used up.'])
  assert.deepEqual(row({ blocked: 'attempts_cap' }), ['exhausted', 'Your 3 free trial scans are used up.'])
  assert.deepEqual(row({ blocked: 'account_total_cap', remaining: 1 }), ['exhausted', "Your free trial's allowance is used up. You have used 2 of 3."])
  assert.deepEqual(row({ blocked: 'ip_throttle', remaining: 3 }), ['throttled', 'Too many free trial scans from your network today. Try again tomorrow. You have used 0 of 3.'])
  assert.deepEqual(row({ blocked: 'global_daily_cap', remaining: 2 }), ['throttled', "Today's free trial scans are fully booked. Try again tomorrow (it resets at midnight UTC). You have used 1 of 3."])
  assert.deepEqual(row({ blocked: 'google_required', remaining: 3 }), ['ineligible', 'Free trial scans need an account that signs in with Google. Sign in with Google to use them.'])
  assert.deepEqual(row({ blocked: 'domain_used', remaining: 3 }), ['ineligible', "Your company's email domain has already had its free trial."])
  assert.deepEqual(row({ blocked: 'something_new' }), ['unavailable', "Free trial scans can't run right now."])
  for (const b of ['not_configured', 'ip_throttle', 'global_daily_cap', 'google_required', 'domain_used', 'something_new']) {
    assert.doesNotMatch(trialCopy(t({ blocked: b, remaining: 3 })).text, /used up/, `${b} is not usage`)
  }
  // Every state offers the one working next step, the account's own key; no operator value is ever in the text.
  for (const b of [null, 'not_configured', 'account_cap', 'ip_throttle', 'global_daily_cap']) {
    const c = trialCopy(t({ blocked: b, funded: b === null, remaining: b === null ? 1 : 0 }))
    assert.equal(c.next.href, '#model-key'); assert.match(c.next.label, /add your AI key/i)
    assert.doesNotMatch(c.text, /\$|sk-|usd|budget/i)
  }
})
