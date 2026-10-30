import { randomBytes } from 'node:crypto'
import { after, NextRequest, NextResponse } from 'next/server'
import { cleanText } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { MAX_QUERY, normalizeIcp } from '@/lib/scan/icp'
import { countActiveJobs, createJob, createQueryJob } from '@/lib/scan/store'
import { hasKey } from '@/lib/llm/key-store'
import { planQuota, readPlan, scansThisMonth } from '@/lib/plans'
import { getDb } from '@/lib/db/client'
import { normalizeSources } from '@/lib/sources'
import { kickRunner } from '@/lib/scan/runner'
import { recordTrialScan, trialStatus } from '@/lib/scan/trial'
import { getAuthDb, sellerProfile } from '@/lib/auth-db'
import { describeRunBudget, normalizeScanBudget } from '@/lib/scan/run-budget'
import { connectorStatus } from '@/lib/connectors/store'
import { estimateForBody } from '@/lib/scan/estimate-request'
import { admitTrialScan, linkTrialReservation, releaseTrialReservation } from '@/lib/billing/trial-budget'
import { denied } from '@/lib/workspace-access'
import { cleanOffer, effectiveOffer } from '@/lib/scan/play-offer'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no

  const rl = (await rateLimit(`scan:${user.tenantId}`, 10, 60 * 60 * 1000))
  // the shared limit could not be checked: no scan and no trial admission (lib/rate-limit.ts fails closed)
  if (rl.unavailable) return NextResponse.json({ error: 'Scans are briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!rl.ok) return NextResponse.json({ error: 'Too many scans. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  // Preferred input: free text, plus an optional profile the user already reviewed or edited.
  const query = cleanText(body?.query, MAX_QUERY)
  const icp = body?.icp === undefined || body?.icp === null ? null : normalizeIcp(body.icp)
  if (body?.icp !== undefined && body?.icp !== null && !icp) return NextResponse.json({ error: 'The profile needs a summary' }, { status: 400 })
  // Legacy input, still accepted for older clients.
  const business_name = cleanText(body?.business_name, 150)
  const industry = cleanText(body?.industry, 100)
  const location = cleanText(body?.location, 100)
  if (query.length < 3 && (!business_name || !industry || !location)) {
    return NextResponse.json({ error: 'Describe who you are looking for' }, { status: 400 })
  }
  // What the tenant sells for THIS play (lib/scan/play-offer.ts): the offer reviewed with the profile, stored with the
  // play. Without one, the play records the business profile's offer; a request that states a different offer is
  // refused until the caller chooses which one this play is for, before anything is queued or counted.
  const seller = sellerProfile(getAuthDb(), user.tenantId)
  const offerSupplied = body?.offer !== undefined && body?.offer !== null
  const offer = offerSupplied ? cleanOffer(body.offer) : ''
  if (offerSupplied && offer.length < 3) return NextResponse.json({ error: 'Say in a few words what you sell for this play' }, { status: 400 })
  if (query.length >= 3 && !offer) {
    const e = effectiveOffer({ seller, query }, null)
    if (e.conflict) return NextResponse.json({ error: 'offer_conflict', stated: e.conflict.stated, saved: e.conflict.recorded, ...(e.conflict.withdrawn ? { withdrawn: e.conflict.withdrawn } : {}) }, { status: 409 })
  }

  // Optional per-run cost controls. Validated BEFORE anything is queued or counted: an explicitly supplied budget that is not
  // strictly valid is rejected, never ignored, so a caller expecting a restricted run is never widened into a full one.
  const budgetSupplied = body !== null && typeof body === 'object' && 'budget' in body
  // mode 'first5': the fast first scan of a new account (free sources only); it takes no other budget so a caller never mixes the two.
  const first5 = body?.mode === 'first5'
  if (body?.mode !== undefined && body.mode !== 'first5') return NextResponse.json({ error: 'unknown_mode' }, { status: 400 })
  if (first5 && budgetSupplied) return NextResponse.json({ error: 'invalid_budget', detail: 'mode first5 takes no budget' }, { status: 400 })
  const nb = first5 ? normalizeScanBudget({ first5: true, paid_fallback: false, credit_enrichment: false }, true) : normalizeScanBudget(budgetSupplied ? body.budget : undefined, budgetSupplied)
  if (!nb.ok) return NextResponse.json({ error: 'invalid_budget', detail: nb.error }, { status: 400 })

  const db = getScanDb()
  // Keyless accounts fall back to the shared trial key: 3 scans per account, throttled per IP
  // per day. With no trial configured, queuing a keyless job would hang forever and burn a scan.
  let funded: 'user' | 'trial' = 'user'
  const ip = clientIp(req)
  if (!hasKey(db, user.tenantId)) {
    // The free trial belongs to the account that founded this workspace (its Google sign-in and email are what the
    // trial's abuse limits check), so only that account, acting in its own workspace, can draw on it.
    if (user.actorId !== user.tenantId) return NextResponse.json({ error: 'no_api_key' }, { status: 400 })
    const t = trialStatus(db, user.tenantId, ip)
    if (!t.funded) {
      if (t.reason === 'account_cap' || t.reason === 'ip_throttle') {
        return NextResponse.json({ error: 'trial_exhausted', used: t.used }, { status: 402 })
      }
      return NextResponse.json({ error: 'no_api_key' }, { status: 400 })
    }
    funded = 'trial'
  }
  // One scan at a time per account: a scan that is running, queued OR still enriching (contacts, people, fit) is active. The Find leads button is
  // disabled for the same reason, but this is the guard: a second paid scan must not start beside an unfinished one.
  if (countActiveJobs(db, user.tenantId) >= 1) {
    return NextResponse.json({ error: 'scan_active', message: 'A scan is still running or finishing. Wait for it to end before starting another.' }, { status: 409 })
  }
  // the plan from the shared store (the Stripe webhook writes it there); the count from where this route writes scans
  const q = planQuota(await readPlan(await getDb(), user.tenantId), scansThisMonth(db, user.tenantId))
  if (!q.allowed) {
    return NextResponse.json({ error: 'quota_exceeded', plan: q.plan, used: q.used, limit: q.limit }, { status: 402 })
  }
  // Refusals that run nothing (over budget, stale estimate) come BEFORE any trial reservation: a refused request must not consume a keyless trial attempt or budget.
  // The price estimate and the hard cap come from one function. A run whose expected model cost is already above the limit left is
  // refused with what to change (402 over_budget); a client that confirmed an estimate sends its ack, and a different current
  // estimate (limit, mode or key changed since) is returned for a fresh confirmation (409 estimate_changed). No paid call happens here.
  const estDb = await getDb()
  const est = await estimateForBody(body, { db: estDb, tenantId: user.tenantId, hasOwnKey: funded === 'user', enrichmentVendors: (await connectorStatus(estDb, user.tenantId).catch(() => [])).filter(c => c.enabled).map(c => c.connector) })
  if (est.ok) {
    if (est.estimate.verdict.reason === 'budget_unknown') return NextResponse.json({ error: 'budget_unknown', message: est.estimate.verdict.message, estimate: est.estimate }, { status: 503, headers: { 'Retry-After': '30' } })
    if (!est.estimate.verdict.ok) return NextResponse.json({ error: 'over_budget', message: est.estimate.verdict.message, change: est.estimate.verdict.change, estimate: est.estimate }, { status: 402 })
    if (typeof body?.estimate_ack === 'string' && body.estimate_ack !== est.estimate.ack) return NextResponse.json({ error: 'estimate_changed', estimate: est.estimate }, { status: 409 })
  }
  // A trial scan runs on dazl's own key: it must also fit dazl's daily trial budget and abuse limits
  // (lib/billing/trial-budget.ts). Checked last, so a refused request above never holds a reservation.
  let reservation: string | null = null
  let job_id: string | null = null
  if (funded === 'trial') {
    const a = await admitTrialScan(await getDb(), { id: user.tenantId, email: user.email })
    if (!a.ok) return NextResponse.json({ error: 'trial_unavailable', reason: a.reason }, { status: 402 })
    reservation = a.reservation
  }
  // From here a reservation exists with no job: any throw before the job is linked releases it, so an error can never leave an attempt and budget consumed with no run.
  try {
    const sel = body?.sources ? normalizeSources(body.sources) : null
    // The job id is fixed FIRST and the trial reservation is linked to it BEFORE the job exists; then the job, its estimate, its funding mark and the trial count are written in ONE
    // transaction. So there is never a pending job that a background worker could claim without its estimate / funding / trial count, and a failure at any step rolls the job back entirely and
    // releases the reservation: no partial job, no consumed attempt.
    job_id = randomBytes(12).toString('hex')
    if (reservation) await linkTrialReservation(await getDb(), user.tenantId, reservation, job_id)
    const jid = job_id
    db.transaction(() => {
      if (query.length >= 3) createQueryJob(db, user.tenantId, { id: jid, query, icp: icp ? JSON.stringify(icp) : null, sources: sel ? JSON.stringify(sel) : null, seller, offer: offer || null, runBudget: nb.value })
      else createJob(db, user.tenantId, { id: jid, business_name, industry, location }, nb.value)
      // Kept with the job so the finished scan can show actual against what was confirmed.
      if (est.ok) db.prepare('UPDATE scan_jobs SET estimate = ? WHERE id = ?').run(JSON.stringify({ total: est.estimate.total, rows: est.estimate.rows, payer: est.estimate.payer, cap: est.estimate.cap, ack: est.estimate.ack }), jid)
      if (funded === 'trial') {
        db.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(jid)
        recordTrialScan(db, user.tenantId, jid, ip)
      }
    })()
    after(() => kickRunner(db))
    // A supplied budget is answered with exactly which paid surfaces it allows or refuses and what the limit is NOT.
    return NextResponse.json(nb.budget ? { job_id, budget: describeRunBudget(nb.budget) } : { job_id }, { status: 202 })
  } catch (e) {
    if (reservation) await releaseTrialReservation(await getDb(), user.tenantId, reservation, job_id ?? undefined).catch(() => { /* stays at its full reserve (never less than it could spend) */ })
    throw e
  }
}
