// #1095: a password account whose first search is refused for the free trial never dead-ends. Every trial refusal
// reason has plain-English copy and one next step (never the raw code), Google-required offers a Link Google path that
// comes back to the same page, and the return address can only ever be a dazl app page. Pure functions; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TRIAL_SCANS_PER_ACCOUNT } from '../lib/scan/trial.ts'
import { TRIAL_REFUSALS } from '../lib/billing/trial-budget.ts'
import { PASSWORD_TRIAL_SCANS } from '../lib/billing/trial-budget.ts'
import { trialRefusalNotice, TRIAL_REFUSAL_COPY, ACCOUNT_LOAD_FAILED, noticeAccount, signUpPlanLine, trialRuleLine } from '../lib/trial-copy.ts'
import { estimateRun, estimatePayerLine } from '../lib/scan/price-estimate.ts'
import { safeNext, linkGoogleHref, googleLinkResultCopy, GOOGLE_LINK_RESULTS } from '../lib/google-link.ts'

const RAW = /\b(trial_unavailable|google_required|domain_used|attempts_cap|account_total_cap|global_daily_cap|not_configured)\b/

// #1704: the account's own key is no longer a way forward (BYOK is being removed, #1703). Google is the one step that opens
// more free searches; a daily limit says when to come back; every other refusal is said in words with nothing to press.
const NEXT: Record<string, string[]> = { google_required: ['link_google'], domain_used: [], attempts_cap: [], account_total_cap: [], global_daily_cap: [], not_configured: [] }
test('#1095: every TrialRefusal member has plain-English copy and its exact next step; a new member without copy fails here', () => {
  assert.deepEqual(Object.keys(TRIAL_REFUSAL_COPY).sort(), [...TRIAL_REFUSALS].sort())
  assert.deepEqual(Object.keys(NEXT).sort(), [...TRIAL_REFUSALS].sort(), 'every reason has its expected step here too')
  for (const r of TRIAL_REFUSALS) {
    const n = trialRefusalNotice(r, '/app', { verified: true, google: false })
    assert.ok(n.text.length > 20, r)
    assert.doesNotMatch(n.text, RAW, `${r}: no raw code on screen`)
    assert.doesNotMatch(n.text, /AI key/, `${r}: no key to add`)
    assert.deepEqual(n.actions.map(a => a.kind), NEXT[r], r)
    for (const a of n.actions) assert.doesNotMatch(a.label, RAW)
  }
  assert.match(trialRefusalNotice('global_daily_cap', '/app', { verified: true, google: false }).text, /Try again tomorrow/, 'a daily limit says when to come back')
  // an unknown reason (a newer server) still reads as words, never the code
  const unknown = trialRefusalNotice('some_new_reason', '/app', { verified: true, google: false })
  assert.equal(unknown.text, "Free searches can't run right now."); assert.deepEqual(unknown.actions, [])
})

test('#1095: google_required on a verified password account offers Link Google back to the same page', () => {
  const n = trialRefusalNotice('google_required', '/app/leads?job_id=abc', { verified: true, google: false })
  assert.match(n.text, /Free searches need a Google account\. Link Google to run this search free \(no card\)\./)
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

test('#1095: a blocked free-trial cost panel never says the shared free trial pays (no payer is claimed for a refused run)', () => {
  for (const why of ['google_required', 'domain_used', 'attempts_cap', 'account_total_cap', 'global_daily_cap']) {
    const est = estimateRun({ budget: null, payer: 'trial', limited: true, trialRefusal: why, trialUsed: 0 })
    assert.equal(est.verdict.ok, false, why); assert.equal(est.verdict.reason, 'trial_unavailable', why)
    const panel = [estimatePayerLine(est) ?? '', ...est.assumptions].join('\n')
    assert.doesNotMatch(panel, /Paid by the shared free trial/i, `${why}: a refused run is not paid by the trial`)
  }
  // a trial run that can go ahead still says who pays; an own-key run says it is billed to the account's keys
  assert.equal(estimatePayerLine(estimateRun({ budget: null, payer: 'trial', limited: true, trialUsed: 0 })), 'Paid by the shared free trial, not billed to you.')
  assert.equal(estimatePayerLine(estimateRun({ budget: null, payer: 'you' })), 'Billed to your own keys and plans.')
})

test('#1095: when the account cannot be read, google_required still offers Link Google back to this page (never a dead end)', () => {
  const failed = noticeAccount(null, null) // GET /api/auth/email failed (network, 5xx, an expired session's 401)
  assert.equal(failed, ACCOUNT_LOAD_FAILED, 'a failed read is not "still loading"')
  const n = trialRefusalNotice('google_required', '/app/leads', failed)
  const link = n.actions.find(a => a.kind === 'link_google')
  assert.ok(link, 'a Link Google button after a failed account read')
  assert.equal(link!.href, '/api/auth/google?link=1&next=%2Fapp%2Fleads')
  assert.deepEqual(n.actions.map(a => a.kind), ['link_google'], 'Link Google only: no key to add (#1704)')
  assert.deepEqual(trialRefusalNotice('google_required', '/app/leads', null).actions, [], 'still loading is different from failed')
  assert.deepEqual(noticeAccount({ verified: false, google: false }, null), { verified: false, google: false, fresh: true })
})

test('#1095 / #1648 / #1704: sign-up says the first search is free on both paths, and one rule line says what Google adds', () => {
  const on = signUpPlanLine(true)
  // #1428: free beta wording, "search" defined, and no key implied where the free first search can run. (Was
  // 'Free plan: 50 scans a month with your own AI key. Sign in with Google (or link it later) for 3 free trial scans first. Upgrade any time.')
  assert.equal(on, 'dazl is free during the beta. A search is one run that looks for businesses that need what you sell. Your first search is free, whether you sign up with Google or with email. No card needed.')
  assert.doesNotMatch(on, /AI key/, '#1704: no key mentioned where the free first search can run')
  assert.doesNotMatch(on, /New accounts may get 3 trial scans/)
  // Where no free search can run, the line says what a search needs here and promises no free one.
  const off = signUpPlanLine(false)
  assert.equal(off, 'dazl is free during the beta. A search is one run that looks for businesses that need what you sell. On this site a search runs on your own Anthropic key, which you add in Settings.')
  assert.doesNotMatch(off, /first search is free/)
  // #1648: the page told two stories (intro: Google or link it later; caption: needs Google sign-in). One rule now, the one
  // the code enforces since #1630: a first free search on either path, up to TRIAL_SCANS_PER_ACCOUNT with Google.
  assert.doesNotMatch(on, /link it later|needs Google/)
  assert.equal(TRIAL_SCANS_PER_ACCOUNT, 3)
  // #1704: the count under the Google button comes from the allowance constants, never a hand-written "three"
  assert.equal(trialRuleLine({ funded: true, emailPath: true, cap: TRIAL_SCANS_PER_ACCOUNT, emailCap: PASSWORD_TRIAL_SCANS }), 'With Google: up to 3 free searches. With email: 1 free search.')
  // review of #1653: where an email sign-up cannot run a free search (the password switch off, or no mail to confirm the
  // address, so the search answers google_required), the line promises the free search with Google only.
  const googleOnly = signUpPlanLine(true, false)
  assert.equal(googleOnly, 'dazl is free during the beta. A search is one run that looks for businesses that need what you sell. Your first search is free when you sign up with Google. No card needed.')
  assert.doesNotMatch(googleOnly, /with email/)
  assert.equal(signUpPlanLine(false, false), off)
  const page = readFileSync(new URL('../app/sign-up/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /emailTrial=\{passwordTrialOn\(\) && systemMailAvailable\(\)\}/)
  const form = readFileSync(new URL('../app/sign-up/sign-up-form.tsx', import.meta.url), 'utf8')
  assert.match(form, /signUpPlanLine\(trialFunded, emailTrial\)/)
  assert.match(form, /data-testid="trial-rule">\{trialRule\}<\/p>/)
  assert.match(page, /trialRule=\{trialRule\}/)
  assert.doesNotMatch(form, /needs Google sign-in/)
})
