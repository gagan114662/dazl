// The free-trial line in Settings (#410): what the account's trial can do now and why, from GET /api/usage's trial block
// ({ funded, remaining, cap, blocked }). Availability and usage are kept apart: a trial that is not set up on this
// deployment, a network or daily limit, an eligibility rule or a missing reason is never described as scans the account
// has used, and an unavailable trial claims nothing about past use either.
// Pure and client-safe. Nothing here reveals the operator key, budgets or caps beyond the account's own scan count.
import type { TrialRefusal } from './billing/trial-budget.ts'
import { linkGoogleHref } from './google-link.ts'

export interface TrialBlock { funded: boolean; remaining: number; cap: number; blocked?: string | null }
export type TrialCopyState = 'available' | 'unavailable' | 'exhausted' | 'throttled' | 'ineligible'
export interface TrialCopy { state: TrialCopyState; text: string; next: { label: string; href: string } }

// The one working next step in every state is the account's own key; the link carries that wording, the text the state.
const key = (label: string) => ({ label, href: '#model-key' })
const SCAN = key('Add your AI key to scan'), KEEP = key('Add your AI key to keep scanning'), NOW = key('Or add your AI key to scan now')

export function trialCopy(t: TrialBlock): TrialCopy {
  const used = Math.max(0, t.cap - t.remaining)
  // The cap counts admitted attempts, failed ones included (lib/billing/trial-budget.ts), not finished scans.
  const usedText = `You have used ${used} of ${t.cap} free trial scan attempts.`
  switch (t.blocked ?? null) {
    case null:
      if (t.funded && t.remaining > 0) return { state: 'available', text: `${t.remaining} of ${t.cap} free trial scans left.`, next: key('Add your AI key for the full plan') }
      // Not funded (or nothing left) with no reason given: say it cannot run, never that scans were used.
      return { state: 'unavailable', text: "Free trial scans can't run right now.", next: SCAN }
    case 'not_configured':
      // No operator key on this deployment. The trial is simply not offered here; this reason is returned before the
      // account's trial history is read, so it says nothing about what this account has or has not used.
      return { state: 'unavailable', text: "Free trial scans aren't available here right now.", next: SCAN }
    case 'account_cap':
    case 'attempts_cap':
      return { state: 'exhausted', text: `You have used all ${t.cap} free trial scan attempts (a failed attempt that cost something counts; one that stopped after an interruption, or at its spending limit before finding any company, does not).`, next: KEEP }
    case 'account_total_cap':
      // The money ceiling, not the attempt count: website reads on the trial (#409) draw on the same allowance, so this
      // can be reached with scan attempts left. The attempt count is stated as it is, never as "used up".
      return { state: 'exhausted', text: `Your free trial's spending allowance is used up (website reads on the trial count toward it). ${usedText}`, next: KEEP }
    case 'ip_throttle':
      return { state: 'throttled', text: `Too many free trial scans from your network today. Try again tomorrow. ${usedText}`, next: NOW }
    case 'global_daily_cap':
      return { state: 'throttled', text: `Today's free trial scans are fully booked. Try again tomorrow (it resets at midnight UTC). ${usedText}`, next: NOW }
    case 'google_required':
      return { state: 'ineligible', text: 'Free trial scans need Google sign-in on this account. Link Google to this account to use them (no card).', next: NOW }
    case 'domain_used':
      return { state: 'ineligible', text: "Your company's email domain has already had its free trial.", next: SCAN }
    default:
      // A reason this screen does not know yet: say it cannot run now, never that scans were used.
      return { state: 'unavailable', text: "Free trial scans can't run right now.", next: SCAN }
  }
}

// #1095: what a refused free-trial scan says, for every refusal reason, and the way forward. Typed against
// TrialRefusal, and tested against its runtime list, so a new reason cannot ship without copy.
type Next = 'link_google' | 'add_key' | 'tomorrow'
export const TRIAL_REFUSAL_COPY: Record<TrialRefusal, { text: string; next: Next }> = {
  google_required: { text: 'Free scans need a Google account. Link Google to run this search free (no card).', next: 'link_google' },
  domain_used: { text: "Your company's email domain has already had its free trial. Add your own AI key to keep scanning.", next: 'add_key' },
  attempts_cap: { text: 'You have used all your free trial scans. Add your own AI key to keep scanning.', next: 'add_key' },
  account_total_cap: { text: 'Your free trial allowance is used up. Add your own AI key to keep scanning.', next: 'add_key' },
  global_daily_cap: { text: "Today's free scans are fully booked. Try again tomorrow (it resets at midnight UTC), or add your own AI key to scan now.", next: 'tomorrow' },
  not_configured: { text: "Free scans aren't available right now. Add your own AI key to scan.", next: 'add_key' },
}
export type NoticeAction = { kind: 'link_google' | 'resend_verification' | 'reauth' | 'add_key'; label: string; href?: string }
export interface TrialNotice { text: string; actions: NoticeAction[] }
const ADD_KEY: NoticeAction = { kind: 'add_key', label: 'Add your AI key', href: '/app/settings#model-key' }

// here: the page to come back to after linking Google. account: GET /api/auth/email ({ verified, google }), or null
// while unknown. Linking needs a confirmed email (lib/auth-google.ts linkGoogle), so an unconfirmed account is asked to
// confirm it first instead of being sent into a link that would fail.
// account.fresh: signed in within the last hour (GET /api/auth/reauth); linking needs it, so a stale session confirms the
// password first instead of coming back from Google with reauth_required. null while unknown: no actions are offered yet.
export function trialRefusalNotice(reason: unknown, here: string, account: { verified: boolean; google: boolean; fresh?: boolean } | null): TrialNotice {
  const c = typeof reason === 'string' && reason in TRIAL_REFUSAL_COPY ? TRIAL_REFUSAL_COPY[reason as TrialRefusal] : null
  if (!c) return { text: "Free trial scans can't run right now. Add your own AI key to scan.", actions: [ADD_KEY] }
  if (c.next !== 'link_google') return { text: c.text, actions: [ADD_KEY] }
  if (!account) return { text: c.text, actions: [] }
  if (!account.verified) {
    return {
      text: `${c.text} First confirm your email: open the link we sent you, then come back and link Google.`,
      actions: [{ kind: 'resend_verification', label: 'Send the confirmation link again' }, ADD_KEY],
    }
  }
  if (account.fresh === false) {
    return { text: `${c.text} First confirm it is you: enter your password.`, actions: [{ kind: 'reauth', label: 'Confirm it is you' }, ADD_KEY] }
  }
  return { text: c.text, actions: [{ kind: 'link_google', label: 'Link Google', href: linkGoogleHref(here) }, ADD_KEY] }
}

// What POST /api/scan's 402 trial_unavailable (with its admission reason) says on the Leads page, in plain words: never the raw error id.
// The money allowance (account_total_cap) is called the free trial allowance; every refusal ends with the one next step, the account's own key.
export function trialRefusedCopy(reason: unknown): string {
  const r = typeof reason === 'string' ? reason : ''
  const head = r === 'account_total_cap' ? 'Your free trial allowance is used up.'
    : r === 'attempts_cap' ? `You have used all ${3} free trial scan attempts.`
    : r === 'global_daily_cap' ? "Today's free trial scans are fully booked. Try again tomorrow."
    : r === 'domain_used' ? 'A free trial has already been used for your company.'
    : r === 'google_required' ? 'The free trial needs a Google sign-in.'
    : "Free trial scans can't run right now."
  return `${head} Add your AI key in Settings to keep scanning.`
}
