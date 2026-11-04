import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { requireUser } from '@/lib/scan/service'
import { budgetedIcp, normalizeIcp } from '@/lib/scan/icp'
import { discover, parseCohort } from '@/lib/scan/lookalike-discovery'
import { denied } from '@/lib/workspace-access'

// Lookalike discovery from the tenant's own customer outcomes (#386). Takes customers / won opportunities AND negative
// examples (lost or bad-fit accounts, competitors), returns the discriminating features with reasons, the held-out
// check, and - only when that check beats chance - a reviewable search profile ({ query, icp }) for POST /api/scan.
// Nothing is searched, stored or charged here: pure computation over the request body, scoped to the caller's session.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = await rateLimit(`lookalike:${user.tenantId}`, 30, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null) as { examples?: unknown } | null
  const cohort = parseCohort(body?.examples)
  if (!cohort.ok) return NextResponse.json({ error: cohort.error, detail: cohort.detail }, { status: 400 })
  const out = discover(cohort.examples)
  if (out.proposal) {
    // The profile must be storable WHOLE by the scan route (its exclusions are part of it): checked here, never truncated.
    const icp = normalizeIcp(out.proposal.icp)
    const sized = icp ? budgetedIcp(icp) : null
    if (!sized || !sized.ok) return NextResponse.json({ ...out, proposal: null, error: 'profile_too_large', detail: 'The customer list does not fit in one search profile. Import fewer accounts.' }, { status: 400 })
  }
  return NextResponse.json(out)
}
