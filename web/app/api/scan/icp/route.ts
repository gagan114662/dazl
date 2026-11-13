import { NextRequest, NextResponse } from 'next/server'
import { cleanText } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { previewIcp } from '@/lib/scan/runner'
import { MAX_QUERY, guardedPreviewResearch, normalizeIcp, previewCoverage } from '@/lib/scan/icp'
import { denied } from '@/lib/workspace-access'
import { PROVIDER_FAILED_COPY } from '@/lib/error-copy'

// Turns "what are you looking for" into an editable profile, using the caller's own key.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = (await rateLimit(`icp:${user.tenantId}`, 30, 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null)
  const query = cleanText(body?.query, MAX_QUERY)
  if (query.length < 3) return NextResponse.json({ error: 'Describe who you are looking for' }, { status: 400 })
  // The profile the person already has (a saved business buyer or a restored play profile), when the caller carries
  // one: its research block - rejections, holds, the typed answer - rides into the draft below, so "Review profile
  // first" can never silently reset a decision. Presence here is NOT a review; it changes no statuses.
  const prior = body?.prior_icp ? normalizeIcp(body.prior_icp) : null
  const out = await previewIcp(getScanDb(), user.tenantId, query, {}, clientIp(req))
  if ('error' in out) {
    // The same truthful spend/failure names as the website profile read (/api/scan/icp-from-url): a budget stop or an
    // accounting pause is never mislabeled as a key problem, and a refused call was never made or charged.
    if (out.error === 'spend_limit') return NextResponse.json({ error: 'spend_limit', message: 'Your workspace AI spend limit for today or this month is reached, so nothing was generated and nothing was charged.' }, { status: 429 })
    if (out.error === 'model_unpriced') return NextResponse.json({ error: 'model_unpriced', message: 'The AI model configured for this workspace has no price bound, so the preview was refused before it ran. Nothing was charged.' }, { status: 503 })
    if (out.error === 'accounting_pending') return NextResponse.json({ error: 'accounting_pending', message: 'The cost of an AI call could not be recorded, so paid generation is paused until that record settles. A recent call - possibly this request - may still be billed to your key.' }, { status: 503 })
    if (out.error === 'spend_unavailable') return NextResponse.json({ error: 'spend_unavailable', message: 'Your spend budget could not be checked just now, so nothing was generated and nothing was charged. Try again shortly.' }, { status: 503 })
    if (out.error === 'provider_failed') return NextResponse.json({ error: 'provider_failed', message: PROVIDER_FAILED_COPY }, { status: 502 })
    return NextResponse.json({ error: out.error }, { status: out.error === 'no_api_key' || out.error === 'key_unreadable' ? 400 : out.error === 'trial_key_invalid' ? 503 : 402 })
  }
  // The fresh fields are the inference's; the research block is the prior profile's, WHOLE - fresh model research
  // is not new provenance, and the prior block's decisions (reviewed statements, rejections, holds, typed answer)
  // keep their exact bindings, always: no merge, no conditional, no silent replacement. Presence here is NOT a
  // review; the editor shows every decision and Run (the explicit review event) applies the canonical semantics.
  if (out.icp && prior?.research) out.icp = { ...out.icp, research: guardedPreviewResearch(out.icp.research, prior.research) }
  // #917: a profile built from the request's own words (no inference, or the funding-stage guard's fallback) is capped;
  // a longer request's tail is disclosed, never implied kept (lib/scan/icp.ts previewCoverage).
  const coverage = previewCoverage(query, out)
  return NextResponse.json(coverage ? { ...out, coverage } : out)
}
