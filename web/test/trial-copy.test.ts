import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trialCopy, trialRefusedCopy, TRIAL_REFUSAL_COPY, type TrialBlock } from '../lib/trial-copy.ts'

// The trial blocks GET /api/usage returns (#410), synthetic. cap 3 is TRIAL_SCANS_PER_ACCOUNT.
const t = (o: Partial<TrialBlock>): TrialBlock => ({ funded: false, remaining: 0, cap: 3, blocked: null, ...o })

test('#410: without the trial on this deployment, any account is told it is unavailable, never what it used', () => {
  // lib/scan/trial.ts returns not_configured with used 0 / remaining 0 BEFORE reading trial_scans, so this block is the
  // same for a brand-new account and one that used trial scans earlier: the copy must claim neither "used up" nor "none".
  const fresh = trialCopy(t({ blocked: 'not_configured' }))
  assert.deepEqual([fresh.state, fresh.text], ['unavailable', "Free searches aren't available here right now."])
  const usedBefore = trialCopy(t({ blocked: 'not_configured', remaining: 0 })) // e.g. 3 trial scans run before the key was removed
  assert.deepEqual(usedBefore, fresh, 'identical input, identical copy')
  for (const c of [fresh, usedBefore]) assert.doesNotMatch(c.text, /used|none|of 3/)
})

test('fail-safe: not funded with no reason, or funded with nothing left, says it cannot run (not exhausted)', () => {
  for (const o of [{ funded: false, remaining: 0, blocked: null }, { funded: false, remaining: 3, blocked: undefined }, { funded: true, remaining: 0, blocked: null }]) {
    const c = trialCopy(t(o))
    assert.deepEqual([c.state, c.text], ['unavailable', "Free searches can't run right now."], JSON.stringify(o))
  }
})

test('each reason has its own state and wording; only real account usage reads as used up', () => {
  const row = (o: Partial<TrialBlock>) => { const c = trialCopy(t(o)); return [c.state, c.text] }
  // #1704: one noun, "free searches", on every page
  assert.deepEqual(row({ funded: true, remaining: 2 }), ['available', '2 free searches left.'])
  assert.deepEqual(row({ funded: true, remaining: 1 }), ['available', '1 free search left.'])
  assert.deepEqual(row({ blocked: 'account_cap' }), ['exhausted', 'You have used all 3 free search attempts (a failed attempt that cost something counts; one that stopped after an interruption, or at its spending limit before finding any company, does not).'])
  assert.deepEqual(row({ blocked: 'attempts_cap' }), ['exhausted', 'You have used all 3 free search attempts (a failed attempt that cost something counts; one that stopped after an interruption, or at its spending limit before finding any company, does not).'], 'attempts, not finished searches')
  assert.deepEqual(row({ blocked: 'account_total_cap', remaining: 1 }), ['exhausted', "Your free searches' spending allowance is used up (website reads on the free trial count toward it). You have used 2 of 3 free search attempts."])
  assert.deepEqual(row({ blocked: 'ip_throttle', remaining: 3 }), ['throttled', 'Too many free searches from your network today. Try again tomorrow. You have used 0 of 3 free search attempts.'])
  assert.deepEqual(row({ blocked: 'global_daily_cap', remaining: 2 }), ['throttled', "Today's free searches are fully booked. Try again tomorrow (it resets at midnight UTC). You have used 1 of 3 free search attempts."])
  assert.deepEqual(row({ blocked: 'google_required', remaining: 3 }), ['ineligible', 'Free searches need Google sign-in on this account. Link Google to this account to use them (no card).'])
  assert.deepEqual(row({ blocked: 'domain_used', remaining: 3 }), ['ineligible', "Your company's email domain has already had its free searches."])
  assert.deepEqual(row({ blocked: 'something_new' }), ['unavailable', "Free searches can't run right now."])
  for (const b of ['not_configured', 'ip_throttle', 'global_daily_cap', 'google_required', 'domain_used', 'something_new']) {
    assert.doesNotMatch(trialCopy(t({ blocked: b, remaining: 3 })).text, /used up|used all/, `${b} is not usage`)
  }
  // #1704: every state offers a step that does not involve the account's own key (BYOK is being removed, #1703); no
  // operator value is ever in the text.
  const NEXT: Record<string, [string, string]> = {
    null: ['Run a search', '/app/leads'], not_configured: ['Try again later', '/app/leads'], account_cap: ['See your plan', '/app/settings#plan'],
    ip_throttle: ['Try again tomorrow', '/app/leads'], global_daily_cap: ['Try again tomorrow', '/app/leads'], domain_used: ['See your plan', '/app/settings#plan'],
    google_required: ['Link Google', '/api/auth/google?link=1&next=%2Fapp%2Fsettings'],
  }
  for (const b of [null, 'not_configured', 'account_cap', 'ip_throttle', 'global_daily_cap', 'domain_used', 'google_required']) {
    const c = trialCopy(t({ blocked: b, funded: b === null, remaining: b === null ? 1 : 0 }))
    assert.deepEqual([c.next.label, c.next.href], NEXT[String(b)], String(b))
    assert.doesNotMatch(c.text + c.next.label, /AI key|\$|sk-|usd|budget/i)
  }
})

test('the Leads page refusal for a trial scan is plain words, the same as the refusal notice, never the raw id', () => {
  assert.equal(trialRefusedCopy('account_total_cap'), "Your free searches' spending allowance is used up.")
  for (const r of ['attempts_cap', 'global_daily_cap', 'domain_used', 'google_required', 'not_configured', undefined, 42]) {
    const c = trialRefusedCopy(r)
    assert.doesNotMatch(c, /trial_unavailable|_cap|domain_used|google_required|undefined/)
    // #1704: no key step (BYOK is being removed, #1703), and the same sentence Home's refusal notice shows
    assert.doesNotMatch(c, /AI key/)
    assert.equal(c, typeof r === 'string' && r in TRIAL_REFUSAL_COPY ? TRIAL_REFUSAL_COPY[r as keyof typeof TRIAL_REFUSAL_COPY].text : "Free searches can't run right now.")
  }
  // the count is never a hand-written number (it was `${3}`)
  assert.equal(trialRefusedCopy('attempts_cap'), 'Your free searches are used up.')
})
