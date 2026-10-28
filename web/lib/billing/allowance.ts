// What each plan actually allows, stated once. Settings, sign-up and the public plans section all render these lines, so
// they can never disagree; test/allowance.test.ts holds them to what the code enforces (lib/plans.ts PLAN_LIMITS, the
// trial cap in lib/scan/trial.ts, the scan route's hourly limit and one-scan-at-a-time rule). Plain constants and
// strings, no imports: client pages import this file.
// The final pricing and key model is the owner's decision; this describes today's behaviour only.

export const PRO_PRICE_USD_MONTH = 49
export const FREE_SCANS_PER_MONTH = 50
export const TRIAL_SCANS = 3            // on dazl's key, before the user adds their own; not counted in the month
export const SCAN_STARTS_PER_HOUR = 10  // any plan (app/api/scan/route.ts)
export const ACTIVE_SCANS = 1           // any plan: a second scan waits for the first to finish

export const AI_COST_LINE = 'After your free scans, scans run on your own AI key (Anthropic), and your provider bills that usage to you directly, separately from dazl.'
export const LIMITS_LINE = `On every plan: up to ${SCAN_STARTS_PER_HOUR} scan starts an hour, ${ACTIVE_SCANS === 1 ? 'one scan running at a time' : `${ACTIVE_SCANS} scans running at a time`}.`
export const FREE_LINE = `Your first ${TRIAL_SCANS} scans are free and need no AI key: dazl pays for them (sign in with Google; while the daily free budget lasts). After that, Free keeps ${FREE_SCANS_PER_MONTH} scans a month on your own AI key.`
export const PRO_LINE = `No monthly scan cap. Still on your own AI key, so your provider's charges grow with how much you scan.`

// The Settings usage line for this month.
export function usageLine(plan: 'free' | 'pro', used: number, limit: number | null): string {
  return limit === null ? `${used} scans this month. Pro has no monthly scan cap.` : `${used} of ${limit} scans used this month.`
}
