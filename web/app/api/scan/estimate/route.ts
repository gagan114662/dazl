import { getMasterKey } from '@/lib/secrets'
import { applyReviewedDraft } from '@/lib/scan/seller-research'
import { issueWebsiteApproval, WEBSITE_PROFILE_REVIEW_MODE } from '@/lib/scan/website-profile-provenance'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { readTenantOffer } from '@/lib/outreach/play-memory'
import { sameOriginJson } from '@/lib/same-origin'
import { carryAdmission } from '@/lib/scan/carry-exclusions'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { readHasKey } from '@/lib/llm/key-store'
import { getDb } from '@/lib/db/client'
import { connectorStatus } from '@/lib/connectors/store'
import { estimateForBody, keyedModel } from '@/lib/scan/estimate-request'
import { denied } from '@/lib/workspace-access'
import { trialAllowanceLeft, trialPrincipal, trialRefusal } from '@/lib/billing/trial-budget'
import { readTrialStatus } from '@/lib/scan/trial'
import { tenantAllowanceLeft } from '@/lib/search/tinyfish'
import { readSellerLine } from '@/lib/auth-db'
import { budgetedIcp, MAX_QUERY, normalizeIcp } from '@/lib/scan/icp'
import { cleanText } from '@/lib/validate'
import { completeOffer, confirmedPlayOffer, effectiveOffer } from '@/lib/scan/play-offer'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Price estimate for a scan request, before anything paid runs. Read-only: it queues nothing, counts nothing against the
// quota or the trial, reserves nothing and calls no provider. POST body = the body POST /api/scan would take.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  const rl = await rateLimit(`scan-estimate:${user.tenantId}`, 60, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = await getDb()   // the Db layer, not the raw SQLite handle
  const query = cleanText(body?.query, MAX_QUERY)
  const websiteReview = body?.mode === WEBSITE_PROFILE_REVIEW_MODE
  if (websiteReview !== (body?.website_draft_receipt !== undefined)) return NextResponse.json({ error: 'website_review_stale' }, { status: 409 })

  // the same carried-exclusion admission POST /api/scan applies, so no cost panel is shown for a list it would refuse
  if (body?.carry_exclude !== undefined && body?.icp != null && !normalizeIcp(body.icp)) {
    return NextResponse.json({ error: 'The profile needs a summary' }, { status: 400 })
  }
  const carry = body?.icp ? { ok: true as const } : carryAdmission(body?.carry_exclude)
  if (!carry.ok) return NextResponse.json({ error: carry.error }, { status: 400 })
  const supplied = body?.offer !== undefined && body?.offer !== null
  if (supplied && !completeOffer(body.offer)) return NextResponse.json({ error: 'Say in a few words what you sell for this play' }, { status: 400 })
  if (query.length >= 3 && !supplied) {
    // Resolve the same recorded or explicit request offer as POST /api/scan,
    // but before presenting a cost panel for the wrong saved buyer context.
    try {
      const seller = await readSellerLine(db, user.tenantId)
      // the same stores POST /api/scan reads (scan store for confirmations and the tenant offer), so the cost panel
      // and scan admission can never disagree on a deploy where the two handles differ
      const confirmed = await confirmedPlayOffer(getScanDb(), user.tenantId, query, seller)
      if (confirmed?.offer === null) return NextResponse.json({ error: 'offer_conflict', stated: null, saved: '', incomplete: true }, { status: 409 })
      if (!confirmed) {
        const result = effectiveOffer({ seller, query }, readTenantOffer(getScanDb(), user.tenantId))
        const conflict = result.conflict ?? (!result.offer || result.source === 'request'
          ? { stated: result.offer, recorded: '', incomplete: true as const } : null)
        if (conflict) return NextResponse.json({ error: 'offer_conflict', stated: conflict.stated,
          saved: conflict.recorded, ...(conflict.ambiguous ? { ambiguous: true } : {}), ...(conflict.incomplete ? { incomplete: true } : {}), ...(conflict.freshTarget ? { fresh_target: true } : {}),
          ...(conflict.withdrawn ? { withdrawn: conflict.withdrawn } : {}) }, { status: 409 })
      }
    } catch (e) {
      captureError(e, { source: 'route', where: '/api/scan/estimate', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
      return NextResponse.json({ error: 'offer_unreadable' }, { status: 503 })
    }
  }
  const vendors = (await connectorStatus(db, user.tenantId).catch(() => [])).filter(c => c.enabled).map(c => c.connector)
  const hasOwnKey = await readHasKey(db, user.tenantId)
  // A keyless account on the shared trial: say up front if POST /api/scan would refuse it (free scans used up, money or day cap), so the screen
  // never offers a Run button that does nothing. A failed read never blocks here: the run's own admission still refuses.
  const refusal = hasOwnKey ? null : await trialPrincipal(db, user).then(p => (p ? trialRefusal(db, p) : null)).catch(() => null)
  const trialUsed = hasOwnKey || !refusal ? null : await readTrialStatus(db, user.tenantId, clientIp(req)).then(t => t.used).catch(() => null)
  // What is left of the trial's dollar allowance, for one line on the panel. A read that fails or a trial that is not configured gives no line, never a block.
  const trialAllowance = hasOwnKey ? null : await trialPrincipal(db, user).then(p => (p ? trialAllowanceLeft(db, p.id) : null)).catch(() => null)
  const r = await estimateForBody(websiteReview ? { ...body, mode: undefined } : body, { db, tenantId: user.tenantId, hasOwnKey, trialRefusal: refusal, trialUsed, trialAllowance, model: await keyedModel(db, user.tenantId), enrichmentVendors: vendors })
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}), ...(r.message ? { message: r.message } : {}), ...(r.loss ? { loss: r.loss } : {}) }, { status: r.status })
  let websiteApproval: string | null = null
  if (body?.website_draft_receipt !== undefined) {
    const offer = completeOffer(body.offer)
    const icp = normalizeIcp(body.icp)
    const final = offer && icp ? budgetedIcp(applyReviewedDraft(icp, offer, { reviewed: true })) : null
    if (query.length >= 3 && body.reviewed === true && offer && final?.ok) {
      try { websiteApproval = issueWebsiteApproval(getMasterKey(), user, body.website_draft_receipt, { query, offer, icpJson: final.json }) }
      catch (error) {
        captureError(error, { source: 'route', where: '/api/scan/estimate', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
        return NextResponse.json({ error: 'website_review_unavailable' }, { status: 503 })
      }
    }
    if (!websiteApproval) return NextResponse.json({ error: 'website_review_stale' }, { status: 409 })
  }
  // #1157: the web search allowance left today, for the warning before confirm. A failed read gives no line, never a block.
  const searchAllowance = await tenantAllowanceLeft(db, user.tenantId, Math.floor(Date.now() / 1000)).catch(() => null)
  return NextResponse.json({ estimate: { ...r.estimate, search_allowance: searchAllowance }, ...(websiteApproval ? { website_approval_receipt: websiteApproval } : {}) })
}
