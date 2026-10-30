// Starting a discovery scan: every check the app's scan route has always run, in the same order, in one place so the
// app route (app/api/scan) and the external API (app/api/v1/discovery, #392) admit a scan by the same rules. Nothing
// here is new: the input validation, offer conflict, budget, own-key/trial funding, one active scan, plan quota and
// trial budget are the scan route's, moved here unchanged. The caller authenticates, checks the role, applies the
// rate limit (scanRateLimit) and parses the body; it kicks the runner when a job was queued.
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { cleanText } from '../validate.ts'
import { rateLimit, type Limit } from '../rate-limit.ts'
import { MAX_QUERY, normalizeIcp } from '../scan/icp.ts'
import { countActiveJobs, createJob, createQueryJob } from '../scan/store.ts'
import { hasKey } from '../llm/key-store.ts'
import { planQuota, readPlan, scansThisMonth } from '../plans.ts'
import { normalizeSources } from '../sources/index.ts'
import { recordTrialScan, trialStatus } from '../scan/trial.ts'
import { describeRunBudget, normalizeScanBudget } from '../scan/run-budget.ts'
import { admitTrialScan, linkTrialReservation } from '../billing/trial-budget.ts'
import { cleanOffer, effectiveOffer } from '../scan/play-offer.ts'

export interface Admitted { status: number; body: Record<string, unknown>; headers?: Record<string, string>; jobId?: string }

// One limit per workspace, shared by the app and the API: a key cannot start scans the app would refuse.
export function scanRateLimit(tenantId: string, d?: Db): Promise<Limit> {
  return rateLimit(`scan:${tenantId}`, 10, 60 * 60 * 1000, d)
}
export function rateLimited(rl: Limit): Admitted | null {
  // the shared limit could not be checked: no scan and no trial admission (lib/rate-limit.ts fails closed)
  if (rl.unavailable) return { status: 503, body: { error: 'Scans are briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, headers: { 'Retry-After': String(rl.retryAfterS) } }
  if (!rl.ok) return { status: 429, body: { error: 'Too many scans. Try again later.' }, headers: { 'Retry-After': String(rl.retryAfterS) } }
  return null
}

export interface ScanCaller {
  tenantId: string
  actorId: string
  email: string
  ip: string
  // the business profile's offer line (sellerProfile from the app's auth store), read by the route
  seller: string
  // the free trial runs on dazl's own key and its abuse limits are the founder's sign-in and IP; the external API never draws on it
  trialAllowed: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function admitScan(db: Database.Database, shared: Db, caller: ScanCaller, body: any): Promise<Admitted> {
  // Preferred input: free text, plus an optional profile the user already reviewed or edited.
  const query = cleanText(body?.query, MAX_QUERY)
  const icp = body?.icp === undefined || body?.icp === null ? null : normalizeIcp(body.icp)
  if (body?.icp !== undefined && body?.icp !== null && !icp) return { status: 400, body: { error: 'The profile needs a summary' } }
  // Legacy input, still accepted for older clients.
  const business_name = cleanText(body?.business_name, 150)
  const industry = cleanText(body?.industry, 100)
  const location = cleanText(body?.location, 100)
  if (query.length < 3 && (!business_name || !industry || !location)) {
    return { status: 400, body: { error: 'Describe who you are looking for' } }
  }
  // What the tenant sells for THIS play (lib/scan/play-offer.ts): the offer reviewed with the profile, stored with the
  // play. Without one, the play records the business profile's offer; a request that states a different offer is
  // refused until the caller chooses which one this play is for, before anything is queued or counted.
  const seller = caller.seller
  const offerSupplied = body?.offer !== undefined && body?.offer !== null
  const offer = offerSupplied ? cleanOffer(body.offer) : ''
  if (offerSupplied && offer.length < 3) return { status: 400, body: { error: 'Say in a few words what you sell for this play' } }
  if (query.length >= 3 && !offer) {
    const e = effectiveOffer({ seller, query }, null)
    if (e.conflict) return { status: 409, body: { error: 'offer_conflict', stated: e.conflict.stated, saved: e.conflict.recorded } }
  }

  // Optional per-run cost controls. Validated BEFORE anything is queued or counted: an explicitly supplied budget that is not
  // strictly valid is rejected, never ignored, so a caller expecting a restricted run is never widened into a full one.
  const budgetSupplied = body !== null && typeof body === 'object' && 'budget' in body
  // mode 'first5': the fast first scan of a new account (free sources only); it takes no other budget so a caller never mixes the two.
  const first5 = body?.mode === 'first5'
  if (body?.mode !== undefined && body.mode !== 'first5') return { status: 400, body: { error: 'unknown_mode' } }
  if (first5 && budgetSupplied) return { status: 400, body: { error: 'invalid_budget', detail: 'mode first5 takes no budget' } }
  const nb = first5 ? normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true) : normalizeScanBudget(budgetSupplied ? body.budget : undefined, budgetSupplied)
  if (!nb.ok) return { status: 400, body: { error: 'invalid_budget', detail: nb.error } }

  // Keyless accounts fall back to the shared trial key: 3 scans per account, throttled per IP
  // per day. With no trial configured, queuing a keyless job would hang forever and burn a scan.
  let funded: 'user' | 'trial' = 'user'
  if (!hasKey(db, caller.tenantId)) {
    // The free trial belongs to the account that founded this workspace (its Google sign-in and email are what the
    // trial's abuse limits check), so only that account, acting in its own workspace, can draw on it.
    if (!caller.trialAllowed || caller.actorId !== caller.tenantId) return { status: 400, body: { error: 'no_api_key' } }
    const t = trialStatus(db, caller.tenantId, caller.ip)
    if (!t.funded) {
      if (t.reason === 'account_cap' || t.reason === 'ip_throttle') {
        return { status: 402, body: { error: 'trial_exhausted', used: t.used } }
      }
      return { status: 400, body: { error: 'no_api_key' } }
    }
    funded = 'trial'
  }
  // One scan at a time per account: a scan that is running, queued OR still enriching (contacts, people, fit) is active. The Find leads button is
  // disabled for the same reason, but this is the guard: a second paid scan must not start beside an unfinished one.
  if (countActiveJobs(db, caller.tenantId) >= 1) {
    return { status: 409, body: { error: 'scan_active', message: 'A scan is still running or finishing. Wait for it to end before starting another.' } }
  }
  // the plan from the shared store (the Stripe webhook writes it there); the count from where this route writes scans
  const q = planQuota(await readPlan(shared, caller.tenantId), scansThisMonth(db, caller.tenantId))
  if (!q.allowed) {
    return { status: 402, body: { error: 'quota_exceeded', plan: q.plan, used: q.used, limit: q.limit } }
  }
  // A trial scan runs on dazl's own key: it must also fit dazl's daily trial budget and abuse limits
  // (lib/billing/trial-budget.ts). Checked last, so a refused request above never holds a reservation.
  let reservation: string | null = null
  if (funded === 'trial') {
    const a = await admitTrialScan(shared, { id: caller.tenantId, email: caller.email })
    if (!a.ok) return { status: 402, body: { error: 'trial_unavailable', reason: a.reason } }
    reservation = a.reservation
  }
  const sel = body?.sources ? normalizeSources(body.sources) : null
  const job_id = query.length >= 3 ? createQueryJob(db, caller.tenantId, { query, icp: icp ? JSON.stringify(icp) : null, sources: sel ? JSON.stringify(sel) : null, seller, offer: offer || null, runBudget: nb.value }) : createJob(db, caller.tenantId, { business_name, industry, location }, nb.value)
  if (funded === 'trial') {
    db.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(job_id)
    recordTrialScan(db, caller.tenantId, job_id, caller.ip)
    if (reservation) await linkTrialReservation(shared, caller.tenantId, reservation, job_id)
  }
  // A supplied budget is answered with exactly which paid surfaces it allows or refuses and what the limit is NOT.
  return { status: 202, body: nb.budget ? { job_id, budget: describeRunBudget(nb.budget) } : { job_id }, jobId: job_id }
}
