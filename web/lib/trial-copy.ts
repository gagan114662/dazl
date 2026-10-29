// The free-trial line in Settings (#410): what the account's trial can do now and why, from GET /api/usage's trial block
// ({ funded, remaining, cap, blocked }). Availability and usage are kept apart: a trial that is not set up on this
// deployment, a network or daily limit, or an eligibility rule is never described as scans the account has used.
// Pure and client-safe. Nothing here reveals the operator key, budgets or caps beyond the account's own scan count.

export interface TrialBlock { funded: boolean; remaining: number; cap: number; blocked?: string | null }
export type TrialCopyState = 'available' | 'unavailable' | 'exhausted' | 'throttled' | 'ineligible'
export interface TrialCopy { state: TrialCopyState; text: string; next: { label: string; href: string } }

// The one working next step in every state is the account's own key; the link carries that wording, the text the state.
const key = (label: string) => ({ label, href: '#model-key' })
const SCAN = key('Add your AI key to scan'), KEEP = key('Add your AI key to keep scanning'), NOW = key('Or add your AI key to scan now')
const plural = (n: number) => `${n} free trial scan${n === 1 ? '' : 's'}`

export function trialCopy(t: TrialBlock): TrialCopy {
  const used = Math.max(0, t.cap - t.remaining)
  const usedText = `You have used ${used} of ${t.cap}.`
  switch (t.blocked ?? null) {
    case null:
      if (t.funded && t.remaining > 0) return { state: 'available', text: `${t.remaining} of ${t.cap} free trial scans left.`, next: key('Add your AI key for the full plan') }
      // Funded but nothing left: the account's own scans are what used it.
      return { state: 'exhausted', text: `Your ${plural(t.cap)} are used up.`, next: KEEP }
    case 'not_configured':
      // No operator key on this deployment: nothing was used, the trial simply is not offered here.
      return { state: 'unavailable', text: "Free trial scans aren't available here right now, so none have been used.", next: SCAN }
    case 'account_cap':
    case 'attempts_cap':
      return { state: 'exhausted', text: `Your ${plural(t.cap)} are used up.`, next: KEEP }
    case 'account_total_cap':
      return { state: 'exhausted', text: `Your free trial's allowance is used up. ${usedText}`, next: KEEP }
    case 'ip_throttle':
      return { state: 'throttled', text: `Too many free trial scans from your network today. Try again tomorrow. ${usedText}`, next: NOW }
    case 'global_daily_cap':
      return { state: 'throttled', text: `Today's free trial scans are fully booked. Try again tomorrow (it resets at midnight UTC). ${usedText}`, next: NOW }
    case 'google_required':
      return { state: 'ineligible', text: 'Free trial scans need an account that signs in with Google. Sign in with Google to use them.', next: NOW }
    case 'domain_used':
      return { state: 'ineligible', text: "Your company's email domain has already had its free trial.", next: SCAN }
    default:
      // A reason this screen does not know yet: say it cannot run now, never that scans were used.
      return { state: 'unavailable', text: "Free trial scans can't run right now.", next: SCAN }
  }
}
