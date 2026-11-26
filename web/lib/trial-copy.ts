// The free-trial lines (#410, #1704): what the account's free searches can do now and why, from GET /api/usage's trial block
// ({ funded, remaining, cap, blocked }). Every page that shows the allowance (Settings > Plan, Home, Plays, the first-run
// screens, sign-up and sign-in) takes its count, noun and rule from here, so no two pages can disagree. Availability and usage are kept apart: a trial that is not set up on this
// deployment, a network or daily limit, an eligibility rule or a missing reason is never described as searches the account
// has used, and an unavailable trial claims nothing about past use either.
// Pure and client-safe. Nothing here reveals the operator key, budgets or caps beyond the account's own search count. The
// numbers always come in from the caller (the API's cap, or the server constants on the sign-up and sign-in pages): this
// module is imported by the browser, so it cannot import the server-side trial module, and it never writes a number itself.
import type { TrialRefusal } from './billing/trial-budget.ts'
import { linkGoogleHref } from './google-link.ts'

// used / exempt: the account's real count and the operator's acceptance-account switch (#1579), when the caller has them.
export interface TrialBlock { funded: boolean; remaining: number; cap: number; blocked?: string | null; used?: number; exempt?: boolean }
export type TrialCopyState = 'available' | 'unavailable' | 'exhausted' | 'throttled' | 'ineligible'
export interface TrialCopy { state: TrialCopyState; text: string; next: { label: string; href: string } }

// The one noun for the allowance on every page.
export const freeSearches = (n: number) => `${n} free search${n === 1 ? '' : 'es'}`
export const trialLeftText = (n: number) => `${freeSearches(n)} left`
export const FREE_SEARCHES_USED_UP = 'Your free searches are used up.'
// The count every page shows while a free search can run, with what the account really used (GET /api/usage's used) when
// known. The QA acceptance account (#1579) has no count to run out of: it says so, with what it used, instead of a full
// allowance that never moves.
export function trialCountText(t: Pick<TrialBlock, 'remaining'> & Partial<Pick<TrialBlock, 'used' | 'exempt'>>): string {
  const used = typeof t.used === 'number' ? t.used : null
  if (t.exempt) return `QA account: unlimited free searches${used !== null ? ` (${used} used)` : ''}`
  return `${trialLeftText(t.remaining)}${used ? ` (${used} used)` : ''}`
}

// The way forward in each state, never the account's own key (BYOK is being removed, #1703). While there is no paid plan to
// move to, the plan is where the allowance is explained.
const RUN = { label: 'Run a search', href: '/app/leads' }, PLAN = { label: 'See your plan', href: '/app/settings#plan' }
const LATER = { label: 'Try again later', href: '/app/leads' }, TOMORROW = { label: 'Try again tomorrow', href: '/app/leads' }

export function trialCopy(t: TrialBlock): TrialCopy {
  const used = Math.max(0, t.cap - t.remaining)
  // The cap counts admitted attempts, failed ones included (lib/billing/trial-budget.ts), not finished searches.
  const usedText = `You have used ${used} of ${t.cap} free search attempts.`
  switch (t.blocked ?? null) {
    case null:
      if (t.funded && t.remaining > 0) return { state: 'available', text: `${trialCountText(t)}.`, next: RUN }
      // Not funded (or nothing left) with no reason given: say it cannot run, never that searches were used.
      return { state: 'unavailable', text: "Free searches can't run right now.", next: LATER }
    case 'not_configured':
      // No operator key on this deployment. The trial is simply not offered here; this reason is returned before the
      // account's trial history is read, so it says nothing about what this account has or has not used.
      return { state: 'unavailable', text: "Free searches aren't available here right now.", next: LATER }
    case 'account_cap':
    case 'attempts_cap':
      return { state: 'exhausted', text: `You have used all ${t.cap} free search attempts (a failed attempt that cost something counts; one that stopped after an interruption, or at its spending limit before finding any company, does not).`, next: PLAN }
    case 'account_total_cap':
      // The money ceiling, not the attempt count: website reads on the trial (#409) draw on the same allowance, so this
      // can be reached with attempts left. The attempt count is stated as it is, never as "used up".
      return { state: 'exhausted', text: `Your free searches' spending allowance is used up (website reads on the free trial count toward it). ${usedText}`, next: PLAN }
    case 'ip_throttle':
      return { state: 'throttled', text: `Too many free searches from your network today. Try again tomorrow. ${usedText}`, next: TOMORROW }
    case 'global_daily_cap': {
      const notice = TRIAL_REFUSAL_COPY.global_daily_cap.text
      return { state: 'throttled', text: t.exempt ? notice : `${notice} ${usedText}`, next: TOMORROW }
    }
    case 'google_required':
      // A password account past its first free search (#1630) is told what it used, not that it never had one.
      if (t.used) return { state: 'ineligible', text: `You have used ${freeSearches(t.used)} on this account. More need Google sign-in: link Google to this account (no card).`, next: { label: 'Link Google', href: linkGoogleHref('/app/settings') } }
      return { state: 'ineligible', text: 'Free searches need Google sign-in on this account. Link Google to this account to use them (no card).', next: { label: 'Link Google', href: linkGoogleHref('/app/settings') } }
    case 'domain_used':
      return { state: 'ineligible', text: "Your company's email domain has already had its free searches.", next: PLAN }
    default:
      // A reason this screen does not know yet: say it cannot run now, never that searches were used.
      return { state: 'unavailable', text: "Free searches can't run right now.", next: LATER }
  }
}

export function unlimitedTrialDailyCap(t: TrialBlock): string | null {
  return t.exempt && t.blocked !== 'global_daily_cap'
    ? 'A shared daily limit still applies. It resets at midnight Toronto time.'
    : null
}

// #1704: the trial line every page shows (Settings > Plan, Plays).
export function trialSummary(t: TrialBlock): { state: TrialCopyState; text: string } {
  const { state, text } = trialCopy(t)
  return { state, text }
}

// #1704: the rule, said the same way on sign-up and sign-in. funded: a free search can be admitted on this deployment
// (trialFundable). emailPath: a password account can run its first search free here (the password switch is on and the
// address can be confirmed by mail). cap / emailCap: TRIAL_SCANS_PER_ACCOUNT and PASSWORD_TRIAL_SCANS, read by the page.
export interface TrialRule { funded: boolean; emailPath: boolean; cap: number; emailCap: number }
export function trialRuleLine(r: TrialRule): string {
  if (!r.funded) return ''
  const google = `With Google: up to ${freeSearches(r.cap)}.`
  return r.emailPath ? `${google} With email: ${freeSearches(r.emailCap)}.` : google
}

// #1095: what a refused free search says, for every refusal reason, and the way forward. Typed against
// TrialRefusal, and tested against its runtime list, so a new reason cannot ship without copy.
type Next = 'link_google' | 'tomorrow' | 'none'
export const TRIAL_REFUSAL_COPY: Record<TrialRefusal, { text: string; next: Next }> = {
  google_required: { text: 'Free searches need a Google account. Link Google to run this search free (no card).', next: 'link_google' },
  domain_used: { text: "Your company's email domain has already had its free searches.", next: 'none' },
  attempts_cap: { text: FREE_SEARCHES_USED_UP, next: 'none' },
  account_total_cap: { text: "Your free searches' spending allowance is used up.", next: 'none' },
  global_daily_cap: { text: "Today's free searches are fully booked. Try again tomorrow (it resets at midnight UTC).", next: 'tomorrow' },
  not_configured: { text: "Free searches aren't available right now.", next: 'none' },
}
const UNKNOWN_REFUSAL = "Free searches can't run right now."
export type NoticeAction = { kind: 'link_google' | 'reauth'; label: string; href?: string }
export interface TrialNotice { text: string; actions: NoticeAction[] }
// here: the page to come back to after linking Google. account: GET /api/auth/email ({ verified, google }), or null
// while unknown. An unconfirmed account links directly: the link confirms the address (lib/auth-google.ts linkGoogle,
// #1095), so no confirmation mail is needed.
// account.fresh: signed in within the last hour (GET /api/auth/reauth); linking needs it, so a stale session confirms the
// password first instead of coming back from Google with reauth_required. null while still loading: no actions yet.
// ACCOUNT_LOAD_FAILED: the account could not be read (network, a 5xx, an expired session). That is never a dead end: Link
// Google is offered anyway, since the server decides the link and answers every case (signed_out, reauth_required,
// mismatch) with its own copy on the way back (#1095).
export const ACCOUNT_LOAD_FAILED = 'failed' as const
export type NoticeAccount = { verified: boolean; google: boolean; fresh: boolean; email?: string }
// The account from GET /api/auth/email and GET /api/auth/reauth bodies (null: that request failed). The email read is what
// matters: when it failed the result is ACCOUNT_LOAD_FAILED, never "still loading". An unreadable reauth reads as fresh
// (the server answers reauth_required on the way back if it is not).
export function noticeAccount(email: { verified?: unknown; google?: unknown; email?: unknown } | null, reauth: { fresh?: unknown } | null): NoticeAccount | typeof ACCOUNT_LOAD_FAILED {
  return email ? { verified: !!email.verified, google: !!email.google, fresh: reauth ? !!reauth.fresh : true, ...(typeof email.email === 'string' ? { email: email.email } : {}) } : ACCOUNT_LOAD_FAILED
}
export function trialRefusalNotice(reason: unknown, here: string, account: { verified: boolean; google: boolean; fresh?: boolean } | typeof ACCOUNT_LOAD_FAILED | null): TrialNotice {
  const c = typeof reason === 'string' && reason in TRIAL_REFUSAL_COPY ? TRIAL_REFUSAL_COPY[reason as TrialRefusal] : null
  // Only Google can open more free searches; every other refusal is said in words with nothing to press.
  if (!c) return { text: UNKNOWN_REFUSAL, actions: [] }
  if (c.next !== 'link_google') return { text: c.text, actions: [] }
  if (!account) return { text: c.text, actions: [] }
  if (account === ACCOUNT_LOAD_FAILED) return { text: c.text, actions: [{ kind: 'link_google', label: 'Link Google', href: linkGoogleHref(here) }] }
  // An unconfirmed account links directly: the Google link confirms the same address (#1095 decision, linkGoogle).
  if (account.fresh === false) {
    return { text: `${c.text} First confirm it is you: enter your password.`, actions: [{ kind: 'reauth', label: 'Confirm it is you' }] }
  }
  return { text: c.text, actions: [{ kind: 'link_google', label: 'Link Google', href: linkGoogleHref(here) }] }
}

// The sign-up page's plan line (#1095, #1428, #1648): free beta, what a search is, and the free first search. Since #1630 a
// confirmed password account gets one free search without Google, so the line promises it to both paths; the rule line
// under the Google button (trialRuleLine) says how many. Shown only where a trial can really be admitted.
const BETA_LINE = 'dazl is free during the beta. A search is one run that looks for businesses that need what you sell.'
// emailPath (review of #1653): whether an email sign-up can really run that first search here. It cannot when the password
// first-search switch is off, or when this site cannot send the confirmation email (the account is then never confirmed and
// the search answers google_required). Then the line promises the free search with Google only.
export function signUpPlanLine(trialFunded: boolean, emailPath = true): string {
  return trialFunded
    ? emailPath
      ? `${BETA_LINE} Your first search is free, whether you sign up with Google or with email. No card needed.`
      : `${BETA_LINE} Your first search is free when you sign up with Google. No card needed.`
    : `${BETA_LINE} On this site a search runs on your own Anthropic key, which you add in Settings.`
}

// What POST /api/scan's 402 trial_unavailable (with its admission reason) says on the Leads page, in plain words: never the
// raw error id. The same sentence as the refusal notice, so the Leads page and Home never word one refusal two ways.
export function trialRefusedCopy(reason: unknown): string {
  return typeof reason === 'string' && reason in TRIAL_REFUSAL_COPY ? TRIAL_REFUSAL_COPY[reason as TrialRefusal].text : UNKNOWN_REFUSAL
}
