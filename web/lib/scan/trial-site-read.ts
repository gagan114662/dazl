import { createHash } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { admitTrialSiteReadBudget, releaseTrialReservation, settleTrialSiteRead, trialPrincipal, type TrialRefusal } from '../billing/trial-budget.ts'
import { rateLimit, type Limit } from '../rate-limit.ts'
import { operatorKey, readTrialStatus, type OperatorKey, type TrialDeny } from './trial.ts'

// #409: reading the user's own website into a profile is the first step of the advertised website -> profile -> first
// leads journey, so an account without its own AI key may have it read on dazl's trial key. Cost authority stays
// explicit and bounded:
//   - only an account the trial would admit right now (lib/scan/trial.ts and lib/billing/trial-budget.ts: operator
//     key, trial budget configured, Google sign-in, one trial per company domain, attempt and spend caps);
//   - the deployment must set its own daily ceiling for these reads (DAZL_TRIAL_SITE_READS_PER_DAY); unset = off;
//   - at most TRIAL_SITE_READS_PER_ACCOUNT per account per 30 days and TRIAL_SITE_READS_PER_IP_PER_DAY per network,
//     counted in the shared rate-limit store, which refuses when it cannot answer (lib/rate-limit.ts: 'closed'). The
//     account's reads are counted LAST, after the network throttle, the deployment ceiling and the wallet admitted the
//     read, so a refusal for any of those (busy, throttled, no money) never uses up one of the account's reads; an
//     admitted read counts whether or not its call then succeeds. A read refused by the account count gives its wallet
//     reservation back (nothing was spent). A reads-used account that keeps pressing costs the network and deployment
//     counters one slot per press, bounded by its network throttle;
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

export type SiteReadRefusal = TrialDeny | TrialRefusal | 'site_reads_used' | 'site_reads_busy' | 'limit_unavailable' | 'workspace_not_eligible'
// settle: the read's call ended, with the cost the provider reported (USD), or null when the call failed or reported no
// usable cost: the reservation then counts its full reserve, but has ended (lib/billing/trial-budget.ts).
export type SiteReadAdmission = { ok: true; key: OperatorKey; settle: (spentUsd: number | null) => Promise<void> } | { ok: false; reason: SiteReadRefusal }

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
  // Network throttle, then the deployment-wide ceiling: the shared counters, which a refusal here leaves untouched for
  // this account's own reads.
  for (const [k, max, windowMs, reason] of [
    [`trial-site-ip:${net}`, TRIAL_SITE_READS_PER_IP_PER_DAY, DAY_MS, 'ip_throttle'],
    ['trial-site-day:all', perDay, DAY_MS, 'site_reads_busy'],
  ] as const) {
    const r = await limit(k, max, windowMs)
    if (!r.ok) return { ok: false, reason: r.unavailable ? 'limit_unavailable' : reason }
  }
  // Then the money: the read's maximum cost reserved in the shared wallet, under its lock, against both ceilings.
  const a = await admitTrialSiteReadBudget(db, user, { env })
  if (!a.ok) return { ok: false, reason: a.reason }
  // Last, the account's own reads: counted only now, for a read everything else admitted. Refused here, the wallet
  // reservation is given back (no call was made); if that fails it ends at its reserve after READ_GRACE_S.
  const own = await limit(`trial-site:${user.id}`, TRIAL_SITE_READS_PER_ACCOUNT, 30 * DAY_MS)
  if (!own.ok) {
    await releaseTrialReservation(db, user.id, a.reservation).catch(() => { /* stays at its reserve until the grace window ends */ })
    return { ok: false, reason: own.unavailable ? 'limit_unavailable' : 'site_reads_used' }
  }
  return { ok: true, key, settle: (spentUsd: number | null) => settleTrialSiteRead(db, user.id, a.reservation, spentUsd) }
}

// The route's admission: the workspace's trial principal (lib/billing/trial-budget.ts trialPrincipal: its founder's
// account, acting itself), or a refusal when there is none.
export async function admitWorkspaceSiteRead(db: Db, user: { tenantId: string; actorId: string }, ip: string, deps: SiteReadDeps = {}): Promise<SiteReadAdmission> {
  const p = await trialPrincipal(db, user)
  return p ? admitTrialSiteRead(db, p, ip, deps) : { ok: false, reason: 'workspace_not_eligible' }
}
