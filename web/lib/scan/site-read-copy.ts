// What the first run says when the website read cannot run on the free trial (app/app/first-run.tsx): the real reason
// from POST /api/scan/icp-from-url (the `trial` refusal of lib/scan/trial-site-read.ts), never a free-start promise,
// with the two ways on (own key, or the profile by hand). Pure, so test/site-read-copy.test.ts can pin each mapping.
const own = 'Add your own Anthropic or OpenAI key to read it, or describe your business yourself.'
export function siteKeyReason(why: string | null): string {
  if (why === 'not_configured') return `The free trial isn't available here right now. ${own}`
  // Only an admitted read counts (lib/scan/trial-site-read.ts): three per 30 days, done or failed on dazl's side after
  // the call; a refusal (ineligible, busy, throttled, no money) or a read its guard refused before any call never uses one.
  // The limiter is a fixed window (lib/rate-limit.ts): all three come back together, 30 days after the first.
  if (why === 'site_reads_used') return `You have used your three free website reads for now; they come back together, 30 days after the first. ${own}`
  if (why === 'workspace_not_eligible') return `The free trial belongs to the account that created this workspace. ${own}`
  if (why === 'google_required') return `The free trial needs an account that signs in with Google. ${own}`
  // Another account on the same company email domain started the trial: this account's own trial is not "used up".
  if (why === 'domain_used') return `Another account at your company's email domain has already started the free trial, and it belongs to that account. ${own}`
  if (why === 'attempts_cap' || why === 'account_cap' || why === 'account_total_cap') return `Your free trial is used up. ${own}`
  if (why === 'ip_throttle' || why === 'global_daily_cap' || why === 'site_reads_busy' || why === 'limit_unavailable') return `The free trial is busy right now. Try again later. ${own}`
  return 'Reading your site runs on your own Anthropic or OpenAI key.'
}
