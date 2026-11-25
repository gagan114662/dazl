// #1704: one free-search count everywhere. Settings > Plan, Home (setup card and first-run), Plays, /sign-up and /sign-in
// used to build their trial lines separately ("3 of 3 free trial scans left", "using free searches (3 left)", "up to three
// free searches", "Free scans need Google sign-in", "Add your AI key"). Every page now renders the same number and noun from
// lib/trial-copy.ts, the rule from the server's allowance constants, and no "Add your AI key" step (BYOK is going, #1703).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TRIAL_SCANS_PER_ACCOUNT } from '../lib/scan/trial.ts'
import { PASSWORD_TRIAL_SCANS } from '../lib/billing/trial-budget.ts'
import { TRIAL_REFUSALS } from '../lib/billing/trial-budget.ts'
import * as copy from '../lib/trial-copy.ts'
import { readyItems } from '../lib/ready-card.ts'
import type { ReadinessInput } from '../lib/readiness.ts'
import { playStatusLabel, runNowMessage } from '../lib/play-new-view.ts'
import { savedPlays, type WatchRow } from '../lib/saved-plays.ts'

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
// What a person reads: comments stripped, so a code comment that mentions the old wording is not the page's copy.
const shown = (p: string) => src(p).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const AI_KEY = /add your (own )?AI key/i

// One trial block as GET /api/usage returns it (app/api/usage/route.ts): cap is TRIAL_SCANS_PER_ACCOUNT.
const TRIAL = { funded: true, remaining: 2, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: null }
const COUNT = '2 free searches left'

test('#1704 one count: the shared summary says the number and the one noun', () => {
  assert.equal(copy.trialLeftText(2), COUNT)
  assert.equal(copy.trialLeftText(1), '1 free search left')
  assert.equal(copy.trialSummary(TRIAL).text, `${COUNT}.`)
  assert.equal(copy.trialSummary(TRIAL).state, 'available')
  assert.equal(copy.trialCopy(TRIAL).text, copy.trialSummary(TRIAL).text, 'the estimate and Settings say the same thing')
})

test('#1704 Settings > Plan renders the shared summary, and hides the plan quota while the account is on the trial', () => {
  const panel = shown('app/app/settings/plan-panel.tsx')
  assert.match(panel, /trialSummary\(u\.trial\)/)
  assert.match(panel, /\(!u\.trial \|\| u\.plan === 'pro'\) && <p[^>]*>\{usageLine\(\{ \.\.\.u, trial: null \}\)\}/, 'the Free plan\'s "0 of 50 scans used" line is not shown next to the trial count; Pro keeps its unlimited line')
  assert.doesNotMatch(panel, /t\.next|#model-key/, 'no key step under the trial line')
})

test('#1704 Home: the setup card says the same count as Settings', () => {
  const i: ReadinessInput = {
    profile: { website: 'https://www.brightsmile.example', sells: 'Online booking', business_name: 'Brightsmile', buyer: { summary: 'Independent dental practices', who: ['Practice owner'] } },
    usage: { has_key: false, trial: TRIAL }, keys: [], rejection: null, outreach: null,
    sources: { web_index: false, news: true, websites: true }, advanced: null, jobs: [], totals: { searches: 0, finished: 0 }, campaigns: [], messages: [],
  }
  const search = readyItems(i).find(x => x.id === 'search')!
  assert.equal(search.state, 'done')
  assert.match(search.detail, new RegExp(`^${COUNT}\\. Sources: `))
  // the first-run screens (Home before the first search) show the same text from the same function
  const firstRun = shown('app/app/first-run.tsx')
  assert.equal((firstRun.match(/trialCountText\(usage\.trial\)/g) ?? []).length, 2, 'the heading and the pill use the shared count')
  assert.doesNotMatch(firstRun, /free search\$\{trialLeft === 1/, 'no second, hand-built count')
})

test('#1704 Plays: the page shows the shared count, and a play paused on used-up free searches asks for no key', () => {
  const plays = shown('app/app/plays/plays-client.tsx')
  assert.match(plays, /trialSummary\(trial\)\.text/, 'Plays reads /api/usage and shows the same count')
  assert.match(plays, /playStatusLabel\(p, listed\)/)
  const w: WatchRow = { id: 'w1', query: 'dental practices hiring', icp: null, active: false, next_run_at: null, last_run_at: null, paused_reason: 'trial_used', last_job_id: null, last_status: null, new_leads: 0 }
  const [p] = savedPlays([w], null, 'UTC', 1)
  const label = playStatusLabel(p, { watches: [w], monitors: [] })
  assert.equal(label, `Paused: ${copy.FREE_SEARCHES_USED_UP.toLowerCase()}`)
  assert.doesNotMatch(label, /AI key/)
  // any other paused reason keeps its own label
  assert.equal(playStatusLabel(p, { watches: [{ ...w, paused_reason: 'quota' }], monitors: [] }), p.status.label)
  for (const e of ['trial_used', 'trial_busy']) assert.doesNotMatch(runNowMessage(402, { error: e }).text, /AI key/, e)
})

test('#1704 sign-up and sign-in: one rule line, built from the server allowance constants, on both pages', () => {
  const both = copy.trialRuleLine({ funded: true, emailPath: true, cap: TRIAL_SCANS_PER_ACCOUNT, emailCap: PASSWORD_TRIAL_SCANS })
  assert.equal(both, `With Google: up to ${TRIAL_SCANS_PER_ACCOUNT} free searches. With email: ${PASSWORD_TRIAL_SCANS} free search.`)
  assert.equal(copy.trialRuleLine({ funded: true, emailPath: false, cap: TRIAL_SCANS_PER_ACCOUNT, emailCap: PASSWORD_TRIAL_SCANS }), `With Google: up to ${TRIAL_SCANS_PER_ACCOUNT} free searches.`)
  assert.equal(copy.trialRuleLine({ funded: false, emailPath: true, cap: TRIAL_SCANS_PER_ACCOUNT, emailCap: PASSWORD_TRIAL_SCANS }), '', 'no promise where no free search can run')
  // the numbers come from the inputs, never from a word in the copy
  assert.equal(copy.trialRuleLine({ funded: true, emailPath: true, cap: 4, emailCap: 2 }), 'With Google: up to 4 free searches. With email: 2 free searches.')
  for (const page of ['app/sign-up/page.tsx', 'app/sign-in/page.tsx']) {
    const s = shown(page)
    assert.match(s, /trialRuleLine\(\{ funded: trialFundable\(\), emailPath: passwordTrialOn\(\) && systemMailAvailable\(\), cap: TRIAL_SCANS_PER_ACCOUNT, emailCap: PASSWORD_TRIAL_SCANS \}\)/, `${page}: the same rule, read on the server`)
  }
  const form = shown('app/sign-up/sign-up-form.tsx')
  assert.equal((form.match(/\{trialRule\}/g) ?? []).length, 2, 'the sign-up and sign-in forms both show the rule line')
  assert.doesNotMatch(form + shown('app/sign-in/page.tsx'), /Free scans need Google sign-in|three free searches/)
  assert.equal('SIGN_UP_GOOGLE_CAPTION' in copy, false, 'the hardcoded "three" caption is gone')
})

test('#1704 QA (exempt) account: the count shows what it really used', () => {
  const qa = copy.trialSummary({ funded: true, remaining: TRIAL_SCANS_PER_ACCOUNT, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: null, exempt: true, used: 5 })
  assert.equal(qa.text, 'QA account: unlimited free searches (5 used).')
  assert.doesNotMatch(qa.text, /3 free searches left/)
})

test('#1704 a password account past its first free search is told what it used, not that it never had one', () => {
  const after = copy.trialSummary({ funded: false, remaining: 0, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: 'google_required', used: 1 })
  assert.equal(after.state, 'ineligible')
  assert.equal(after.text, 'You have used 1 free search on this account. More need Google sign-in: link Google to this account (no card).')
  assert.equal(copy.trialCopy({ funded: false, remaining: 0, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: 'google_required', used: 1 }).next.label, 'Link Google')
  // nothing used yet (an unconfirmed address, or the password path off): the plain Google rule
  assert.doesNotMatch(copy.trialSummary({ funded: false, remaining: 0, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: 'google_required', used: 0 }).text, /used/)
})

test('#1704 no "Add your AI key" anywhere a trial line is shown', () => {
  const blocks = [null, 'not_configured', 'account_cap', 'attempts_cap', 'account_total_cap', 'ip_throttle', 'global_daily_cap', 'google_required', 'domain_used', 'something_new']
  const texts: string[] = []
  for (const b of blocks) {
    const c = copy.trialCopy({ funded: b === null, remaining: b === null ? 2 : 1, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: b })
    texts.push(c.text, c.next.label, copy.trialSummary({ funded: b === null, remaining: 1, cap: TRIAL_SCANS_PER_ACCOUNT, blocked: b }).text)
    assert.notEqual(c.next.href, '#model-key', String(b))
  }
  for (const r of [...TRIAL_REFUSALS, 'some_new_reason', undefined]) {
    texts.push(copy.trialRefusedCopy(r))
    for (const acct of [{ verified: true, google: false, fresh: true }, copy.ACCOUNT_LOAD_FAILED, null] as const) {
      const n = copy.trialRefusalNotice(r, '/app', acct)
      texts.push(n.text, ...n.actions.map(a => a.label))
      assert.ok(n.actions.every(a => a.kind === 'link_google' || a.kind === 'reauth'), `${r}: only Google or confirm-it-is-you steps`)
    }
  }
  for (const funded of [true, false]) for (const email of [true, false]) texts.push(copy.signUpPlanLine(funded, email))
  for (const t of texts) assert.doesNotMatch(t, /AI key/, t)
  // the trial count is never hand-written as a number in the copy (it was `${3}` on the Leads refusal)
  assert.doesNotMatch(src('lib/trial-copy.ts'), /\$\{3\}|three free/)
  for (const p of ['lib/trial-copy.ts', 'app/app/settings/plan-panel.tsx', 'app/app/first-run.tsx', 'app/app/plays/plays-client.tsx', 'lib/play-new-view.ts', 'lib/ready-card.ts', 'app/sign-up/sign-up-form.tsx', 'app/sign-up/page.tsx', 'app/sign-in/page.tsx']) {
    assert.doesNotMatch(shown(p), AI_KEY, p)
  }
})
