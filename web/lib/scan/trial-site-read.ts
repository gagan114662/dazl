import { createHash } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { admitTrialSiteReadBudget, settleTrialSiteRead, type TrialRefusal } from '../billing/trial-budget.ts'
import { rateLimit, type Limit } from '../rate-limit.ts'
import { operatorKey, readTrialStatus, type OperatorKey, type TrialDeny } from './trial.ts'

// #409: reading the user's own website into a profile is the first step of the advertised website -> profile -> first
// leads journey, so an account without its own AI key may have it read on dazl's trial key. Cost authority stays
// explicit and bounded:
//   - only an account the trial would admit right now (lib/scan/trial.ts and lib/billing/trial-budget.ts: operator
//     key, trial budget configured, Google sign-in, one trial per company domain, attempt and spend caps);
//   - the deployment must set its own daily ceiling for these reads (DAZL_TRIAL_SITE_READS_PER_DAY); unset = off;
//   - at most TRIAL_SITE_READS_PER_ACCOUNT per account per 30 days and TRIAL_SITE_READS_PER_IP_PER_DAY per network,
//     counted in the shared rate-limit store, which refuses when it cannot answer (lib/rate-limit.ts: 'closed');
//   - one model call per read, bounded by the page text cap (lib/scan/icp-from-site.ts) and its output cap;
//   - paid from the same wallet as trial scans: the read's maximum cost is reserved under the trial budget lock (lib/
//     billing/trial-budget.ts admitTrialSiteReadBudget) and counts toward the account-total and daily-global ceilings
//     until its call settles to the reported cost, in full even above the reserve (a failed or unreported call keeps
//     the full reserve).
// A site read does not use one of the account's trial scan attempts; those stay for scans. Called only after the page
// was fetched and found readable, so a fetch failure or a JS-only page never counts.

export const TRIAL_SITE_READS_PER_ACCOUNT = 3
export const TRIAL_SITE_READS_PER_IP_PER_DAY = 6
const DAY_MS = 86_400_000

export type SiteReadRefusal = TrialDeny | TrialRefusal | 'site_reads_used' | 'site_reads_busy' | 'limit_unavailable'
// settle: the read's call ended and the provider reported its cost (USD); not called when the call failed or the cost is
// unknown, so the reservation keeps counting in full.
export type SiteReadAdmission = { ok: true; key: OperatorKey; settle: (spentUsd: number) => Promise<void> } | { ok: false; reason: SiteReadRefusal }

export function trialSiteReadsPerDay(env: Record<string, string | undefined> = process.env): number | null {
  const v = env.DAZL_TRIAL_SITE_READS_PER_DAY?.trim()
  const n = v ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

export interface SiteReadDeps { env?: Record<string, string | undefined>; limit?: (key: string, max: number, windowMs: number) => Promise<Limit> }

export async function admitTrialSiteRead(db: Db, user: { id: string; email: string }, ip: string, deps: SiteReadDeps = {}): Promise<SiteReadAdmission> {
  const env = deps.env ?? process.env
  const key = operatorKey(env as NodeJS.ProcessEnv)
  const perDay = trialSiteReadsPerDay(env)
  if (!key || perDay === null) return { ok: false, reason: 'not_configured' }
  // The trial's per-account scan count and network throttle (lib/scan/trial.ts). Eligibility (Google sign-in, one trial
  // per company domain, attempts) and the money ceilings are checked with the read's own reserve when it is admitted
  // into the wallet below.
  const status = await readTrialStatus(db, user.id, ip)
  if (!status.funded) return { ok: false, reason: status.reason ?? 'not_configured' }
  const limit = deps.limit ?? rateLimit
  const net = createHash('sha256').update(`site-read:${ip}`).digest('hex').slice(0, 24)
  // Account first, then network, then the deployment-wide ceiling, so one account cannot use up the shared allowance.
  for (const [k, max, windowMs, reason] of [
    [`trial-site:${user.id}`, TRIAL_SITE_READS_PER_ACCOUNT, 30 * DAY_MS, 'site_reads_used'],
    [`trial-site-ip:${net}`, TRIAL_SITE_READS_PER_IP_PER_DAY, DAY_MS, 'ip_throttle'],
    ['trial-site-day:all', perDay, DAY_MS, 'site_reads_busy'],
  ] as const) {
    const r = await limit(k, max, windowMs)
    if (!r.ok) return { ok: false, reason: r.unavailable ? 'limit_unavailable' : reason }
  }
  // Last, the money: the read's maximum cost reserved in the shared wallet, under its lock, against both ceilings.
  const a = await admitTrialSiteReadBudget(db, user, { env })
  if (!a.ok) return { ok: false, reason: a.reason }
  return { ok: true, key, settle: (spentUsd: number) => settleTrialSiteRead(db, user.id, a.reservation, spentUsd) }
}
