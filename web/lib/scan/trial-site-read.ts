import { createHash } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { admitTrialSiteReadBudget, releaseTrialReservation, settleTrialSiteRead, trialPrincipal, trialRefusal, TRIAL_SITE_READ_RESERVE_USD, type TrialRefusal } from '../billing/trial-budget.ts'
import { rateLimit, refundRateLimit, type Limit } from '../rate-limit.ts'
import { captureError } from '../ops/errors.ts'
import { operatorKey, readTrialStatus, type OperatorKey, type TrialDeny } from './trial.ts'

// #409: reading the user's own website into a profile is the first step of the advertised website -> profile -> first
// leads journey, so an account without its own AI key may have it read on dazl's trial key. Cost authority stays
// explicit and bounded:
//   - only an account the trial would admit right now (lib/scan/trial.ts and lib/billing/trial-budget.ts: operator
//     key, trial budget configured, Google sign-in, one trial per company domain, attempt and spend caps);
//   - the deployment must set its own daily ceiling for these reads (DAZL_TRIAL_SITE_READS_PER_DAY); unset = off;
//   - at most TRIAL_SITE_READS_PER_ACCOUNT per account per 30 days and TRIAL_SITE_READS_PER_IP_PER_DAY per network,
//     counted in the shared rate-limit store, which refuses when it cannot answer (lib/rate-limit.ts: 'closed'). The
//     account's reads are counted after eligibility and before the shared counters, and every slot a refused admission
//     took (account, network, deployment) is given back, so a refusal for any reason (ineligible, at its cap, busy,
//     throttled, no money) uses up nothing of anyone's; an admitted read counts whether or not its call then succeeds,
//     except when the read's own guard refused it before any call (then it is released: reservation and slots given
//     back, each into the window it was counted in). An account at its own cap, or one the trial would refuse, cannot
//     drain the shared allowance. Concurrent presses from one account each raise its count before the refunds land, so
//     the surplus ones are refused; they say 'site_reads_busy' unless three reads are really held in the wallet;
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
// release: no call was made at all (the read's own guard refused first): the reservation and the account's read go back.
export type SiteReadAdmission = { ok: true; key: OperatorKey; settle: (spentUsd: number | null) => Promise<void>; release: () => Promise<void> } | { ok: false; reason: SiteReadRefusal }

// A plain positive decimal integer only ('1e1', '0x5', '5.0' are off: an operator ceiling is never guessed at).
export function trialSiteReadsPerDay(env: Record<string, string | undefined> = process.env): number | null {
  const v = env.DAZL_TRIAL_SITE_READS_PER_DAY?.trim() ?? ''
  if (!/^\d{1,9}$/.test(v)) return null
  const n = Number(v)
  return n > 0 ? n : null
}

export interface SiteReadDeps { env?: Record<string, string | undefined>; limit?: (key: string, max: number, windowMs: number) => Promise<Limit>; refund?: (key: string, resetAt?: number) => Promise<boolean> }

// Order (council on #444): nothing is counted or reserved for an account the trial would refuse anyway; the account's
// own reads are taken first, so an account at its cap never touches the shared counters; every slot taken is given back
// when a later step refuses (nothing ran), and so is the wallet reservation.
export async function admitTrialSiteRead(db: Db, user: { id: string; email: string }, ip: string, deps: SiteReadDeps = {}): Promise<SiteReadAdmission> {
  const env = deps.env ?? process.env
  const key = operatorKey(env as NodeJS.ProcessEnv)
  const perDay = trialSiteReadsPerDay(env)
  if (!key || perDay === null) return { ok: false, reason: 'not_configured' }
  // 1. Eligibility, reserving and counting nothing: the trial's per-account scan count and network throttle (lib/scan/
  //    trial.ts), then the wallet's rules against the read's own reserve (Google sign-in, one trial per company domain,
  //    attempts, money ceilings). An account refused here takes no slot of any counter.
  const status = await readTrialStatus(db, user.id, ip, new Date(), env as NodeJS.ProcessEnv)
  if (!status.funded) return { ok: false, reason: status.reason ?? 'not_configured' }
  const why = await trialRefusal(db, user, { env, reserveUsd: TRIAL_SITE_READ_RESERVE_USD })
  if (why) return { ok: false, reason: why }
  // 2. The counters: the account's own reads first (an account at its cap stops here and burns nothing shared), then the
  //    network throttle, then the deployment-wide ceiling. A refusal gives back every slot this call took.
  const limit = deps.limit ?? rateLimit, refund = deps.refund ?? ((k: string, resetAt?: number) => refundRateLimit(k, undefined, Date.now(), resetAt))
  // Each slot is given back into the window it was counted in (Limit.resetAt), never into a window that rolled meanwhile.
  const taken: { key: string; resetAt?: number }[] = []
  const giveBack = async () => { for (const t of taken.splice(0)) await refund(t.key, t.resetAt).catch(e => captureError(e, { source: 'process', where: 'trial-site-read:refund', tenantId: user.id })) }
  const net = createHash('sha256').update(`site-read:${ip}`).digest('hex').slice(0, 24)
  const accountKey = `trial-site:${user.id}`
  for (const [k, max, windowMs, reason] of [
    [accountKey, TRIAL_SITE_READS_PER_ACCOUNT, 30 * DAY_MS, 'site_reads_used'],
    [`trial-site-ip:${net}`, TRIAL_SITE_READS_PER_IP_PER_DAY, DAY_MS, 'ip_throttle'],
    ['trial-site-day:all', perDay, DAY_MS, 'site_reads_busy'],
  ] as const) {
    const r = await limit(k, max, windowMs)
    if (r.unavailable) { await giveBack(); return { ok: false, reason: 'limit_unavailable' } }
    taken.push({ key: k, resetAt: r.resetAt }) // counted whether or not it fit: a refused call still raised the window's count
    if (!r.ok) {
      await giveBack()
      // The account's own count refuses for presses still in flight as much as for reads really held (every press raises
      // the count first; a refused one is given back a moment later). "Used" is said only when three reads of this
      // account are actually held in the wallet (admitted in this window and not released); otherwise it is a moment's
      // crowding: busy.
      if (k === accountKey && r.resetAt !== undefined) {
        const held = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trial_reservations WHERE tenant_id = ? AND kind = 'site_read' AND created_at >= ?", [user.id, Math.floor((r.resetAt - 30 * DAY_MS) / 1000)])
        if (Number(held?.n ?? TRIAL_SITE_READS_PER_ACCOUNT) < TRIAL_SITE_READS_PER_ACCOUNT) return { ok: false, reason: 'site_reads_busy' }
      }
      return { ok: false, reason }
    }
  }
  // 3. Last, the money: the read's maximum cost reserved in the shared wallet, under its lock (step 1's rules checked
  //    again, atomically, against the room left now). Refused: every slot goes back.
  const a = await admitTrialSiteReadBudget(db, user, { env })
  if (!a.ok) { await giveBack(); return { ok: false, reason: a.reason } }
  return {
    ok: true, key,
    settle: (spentUsd: number | null) => settleTrialSiteRead(db, user.id, a.reservation, spentUsd),
    // The read's own guard refused before any call (lib/scan/icp-from-site.ts): nothing was spent, so the reservation and
    // every slot go back. Once only: the slots are given back only when this call deleted the reservation (a second
    // release, or one after a settle, changes nothing). A release that fails is recorded (lib/ops/errors.ts) and leaves
    // the reservation unsettled, which the account keeps paying at its full reserve (READ_GRACE_S ends only its day
    // count); its slots stay spent with it.
    release: async () => {
      let gone = false
      try { gone = await releaseTrialReservation(db, user.id, a.reservation) } catch (e) { captureError(e, { source: 'process', where: 'trial-site-read:release', tenantId: user.id }) }
      if (gone) await giveBack()
    },
  }
}

// The route's admission: the workspace's trial principal (lib/billing/trial-budget.ts trialPrincipal: its founder's
// account, acting itself), or a refusal when there is none.
export async function admitWorkspaceSiteRead(db: Db, user: { tenantId: string; actorId: string }, ip: string, deps: SiteReadDeps = {}): Promise<SiteReadAdmission> {
  const p = await trialPrincipal(db, user)
  return p ? admitTrialSiteRead(db, p, ip, deps) : { ok: false, reason: 'workspace_not_eligible' }
}
