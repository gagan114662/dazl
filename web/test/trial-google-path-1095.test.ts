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
  const unknown = trialRefusalNotice('some_new_reason', '/app', { verified: true, google: false })
  assert.doesNotMatch(unknown.text, RAW); assert.ok(unknown.actions.length >= 1)
})

test('#1095: google_required on a verified password account offers Link Google back to the same page', () => {
  const n = trialRefusalNotice('google_required', '/app/leads?job_id=abc', { verified: true, google: false })
  assert.match(n.text, /Free scans need a Google account\. Link Google to run this search free \(no card\)\./)
  const link = n.actions.find(a => a.kind === 'link_google')
  assert.ok(link, 'a Link Google button')
  assert.equal(link!.href, '/api/auth/google?link=1&next=%2Fapp%2Fleads%3Fjob_id%3Dabc')
})

test('#1095: google_required on an UNCONFIRMED account offers Link Google directly (the link confirms the same address), never a confirm-email step', () => {
  const n = trialRefusalNotice('google_required', '/app/leads', { verified: false, google: false, fresh: true })
  const link = n.actions.find(a => a.kind === 'link_google')
  assert.ok(link, 'Link Google, even before the email is confirmed')
  assert.equal(link!.href, '/api/auth/google?link=1&next=%2Fapp%2Fleads')
  assert.doesNotMatch(n.text, /confirm your email|link we sent/i, 'prod sends no confirmation mail (#1089): never send the user to wait for one')
})

test('#1095: no button before the account is known; a stale session confirms the password before linking (never a reauth_required dead end)', () => {
  assert.deepEqual(trialRefusalNotice('google_required', '/app', null).actions, [], 'nothing to click until verified/fresh is known')
  const stale = trialRefusalNotice('google_required', '/app/leads', { verified: true, google: false, fresh: false })
  assert.ok(stale.actions.some(a => a.kind === 'reauth'), 'confirm it is you')
  assert.ok(!stale.actions.some(a => a.kind === 'link_google'), 'Link Google would come back reauth_required')
  assert.match(stale.text, /confirm it is you/i)
  assert.ok(trialRefusalNotice('google_required', '/app', { verified: true, google: false, fresh: true }).actions.some(a => a.kind === 'link_google'))
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

test('#1095: Settings offers "Add Google sign-in" to an unconfirmed account too (the link confirms the address); no confirm-first gate', async () => {
  const { readFileSync } = await import('node:fs')
  const panel = readFileSync(new URL('../app/app/settings/account-panel.tsx', import.meta.url), 'utf8')
  const link = /\{([^{}]*)&&\s*<a[^>]*href="\/api\/auth\/google\?link=1"/.exec(panel)
  assert.ok(link, 'the Add Google sign-in link is rendered under a condition')
  assert.equal(link![1].trim(), '!s.google', 'shown whenever Google is not linked yet, confirmed or not')
})
