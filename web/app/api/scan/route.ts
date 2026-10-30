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
import { admitTrialScan, linkTrialReservation } from '@/lib/billing/trial-budget'
import { cleanOffer, effectiveOffer } from '@/lib/scan/play-offer'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const rl = (await rateLimit(`scan:${user.id}`, 10, 60 * 60 * 1000))
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
  const seller = sellerProfile(getAuthDb(), user.id)
  const offerSupplied = body?.offer !== undefined && body?.offer !== null
  const offer = offerSupplied ? cleanOffer(body.offer) : ''
  if (offerSupplied && offer.length < 3) return NextResponse.json({ error: 'Say in a few words what you sell for this play' }, { status: 400 })
  if (query.length >= 3 && !offer) {
    const e = effectiveOffer({ seller, query }, null)
    if (e.conflict) return NextResponse.json({ error: 'offer_conflict', stated: e.conflict.stated, saved: e.conflict.recorded }, { status: 409 })
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
  if (!hasKey(db, user.id)) {
    const t = trialStatus(db, user.id, ip)
    if (!t.funded) {
      if (t.reason === 'account_cap' || t.reason === 'ip_throttle') {
        // reason (#410): the account's own attempts are used up (account_cap), or its network is throttled (ip_throttle),
        // so the page never calls a throttle "used up"
        return NextResponse.json({ error: 'trial_exhausted', reason: t.reason, used: t.used }, { status: 402 })
      }
      return NextResponse.json({ error: 'no_api_key' }, { status: 400 })
    }
    funded = 'trial'
  }
  // One scan at a time per account: a scan that is running, queued OR still enriching (contacts, people, fit) is active. The Find leads button is
  // disabled for the same reason, but this is the guard: a second paid scan must not start beside an unfinished one.
  if (countActiveJobs(db, user.id) >= 1) {
    return NextResponse.json({ error: 'scan_active', message: 'A scan is still running or finishing. Wait for it to end before starting another.' }, { status: 409 })
  }
  // the plan from the shared store (the Stripe webhook writes it there); the count from where this route writes scans
  const q = planQuota(await readPlan(await getDb(), user.id), scansThisMonth(db, user.id))
  if (!q.allowed) {
    return NextResponse.json({ error: 'quota_exceeded', plan: q.plan, used: q.used, limit: q.limit }, { status: 402 })
  }
  // A trial scan runs on dazl's own key: it must also fit dazl's daily trial budget and abuse limits
  // (lib/billing/trial-budget.ts). Checked last, so a refused request above never holds a reservation.
  let reservation: string | null = null
  if (funded === 'trial') {
    const a = await admitTrialScan(await getDb(), { id: user.id, email: user.email })
    if (!a.ok) return NextResponse.json({ error: 'trial_unavailable', reason: a.reason }, { status: 402 })
    reservation = a.reservation
  }
  const sel = body?.sources ? normalizeSources(body.sources) : null
  const job_id = query.length >= 3 ? createQueryJob(db, user.id, { query, icp: icp ? JSON.stringify(icp) : null, sources: sel ? JSON.stringify(sel) : null, seller, offer: offer || null, runBudget: nb.value }) : createJob(db, user.id, { business_name, industry, location }, nb.value)
  if (funded === 'trial') {
    db.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(job_id)
    recordTrialScan(db, user.id, job_id, ip)
    if (reservation) await linkTrialReservation(await getDb(), user.id, reservation, job_id)
  }
  after(() => kickRunner(db))
  // A supplied budget is answered with exactly which paid surfaces it allows or refuses and what the limit is NOT.
  return NextResponse.json(nb.budget ? { job_id, budget: describeRunBudget(nb.budget) } : { job_id }, { status: 202 })
}
