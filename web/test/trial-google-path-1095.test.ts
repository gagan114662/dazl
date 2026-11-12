// #1095: a password account whose first search is refused for the free trial never dead-ends. Every trial refusal
// reason has plain-English copy and one next step (never the raw code), Google-required offers a Link Google path that
// comes back to the same page, and the return address can only ever be a dazl app page. Pure functions; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TRIAL_REFUSALS } from '../lib/billing/trial-budget.ts'
import { trialRefusalNotice, TRIAL_REFUSAL_COPY } from '../lib/trial-copy.ts'
import { safeNext, linkGoogleHref, googleLinkResultCopy, GOOGLE_LINK_RESULTS } from '../lib/google-link.ts'

const RAW = /\b(trial_unavailable|google_required|domain_used|attempts_cap|account_total_cap|global_daily_cap|not_configured)\b/

test('#1095: every TrialRefusal member has plain-English copy and a next step; a new member without copy fails here', () => {
  assert.deepEqual(Object.keys(TRIAL_REFUSAL_COPY).sort(), [...TRIAL_REFUSALS].sort())
  for (const r of TRIAL_REFUSALS) {
    const n = trialRefusalNotice(r, '/app', { verified: true, google: false })
    assert.ok(n.text.length > 20, r)
    assert.doesNotMatch(n.text, RAW, `${r}: no raw code on screen`)
    assert.ok(n.actions.length >= 1, `${r}: always a way forward`)
    for (const a of n.actions) assert.doesNotMatch(a.label, RAW)
  }
  // an unknown reason (a newer server) still reads as words with a next step
  const unknown = trialRefusalNotice('some_new_reason', '/app', null)
  assert.doesNotMatch(unknown.text, RAW); assert.ok(unknown.actions.length >= 1)
})

test('#1095: google_required on a verified password account offers Link Google back to the same page', () => {
  const n = trialRefusalNotice('google_required', '/app/leads?job_id=abc', { verified: true, google: false })
  assert.match(n.text, /Free scans need a Google account\. Link Google to run this search free \(no card\)\./)
  const link = n.actions.find(a => a.kind === 'link_google')
  assert.ok(link, 'a Link Google button')
  assert.equal(link!.href, '/api/auth/google?link=1&next=%2Fapp%2Fleads%3Fjob_id%3Dabc')
})

test('#1095: google_required on an unverified account asks to confirm the email first (linking needs it), never a dead end', () => {
  const n = trialRefusalNotice('google_required', '/app', { verified: false, google: false })
  assert.ok(n.actions.some(a => a.kind === 'resend_verification'), 'resend the confirmation link')
  assert.match(n.text, /confirm your email/i)
  assert.ok(!n.actions.some(a => a.kind === 'link_google'), 'Link Google would fail (unverified) until the email is confirmed')
})

test('#1095: the return address is only ever a dazl app page (no open redirect)', () => {
  for (const ok of ['/app', '/app/leads', '/app/leads?job_id=abc123', '/app/leads?job_id=a-b_c&tab=2']) assert.equal(safeNext(ok), ok, ok)
  for (const bad of [null, undefined, '', 'https://evil.example/app', '//evil.example/app', '/\\evil.example', '/apps', '/appx/leads', '/sign-in', '/app/../admin',
    '/app/leads?next=https://evil.example', '/app\nSet-Cookie: x', '/app/%2F%2Fevil', 'javascript:alert(1)', '/app#frag', '/app/' + 'a'.repeat(300)]) {
    assert.equal(safeNext(bad), null, String(bad))
  }
  assert.equal(linkGoogleHref('/app/leads?job_id=abc'), '/api/auth/google?link=1&next=%2Fapp%2Fleads%3Fjob_id%3Dabc')
  assert.equal(linkGoogleHref('https://evil.example'), '/api/auth/google?link=1', 'an unsafe page is dropped, never passed on')
})

test('#1095: every link result the callback can return has copy; linked and already say the search can run now', () => {
  for (const r of GOOGLE_LINK_RESULTS) assert.ok(googleLinkResultCopy(r).text.length > 10, r)
  assert.equal(googleLinkResultCopy('linked').ok, true)
  assert.equal(googleLinkResultCopy('already').ok, true)
  for (const r of ['taken', 'mismatch', 'unverified', 'signed_out', 'reauth_required'] as const) assert.equal(googleLinkResultCopy(r).ok, false, r)
})
