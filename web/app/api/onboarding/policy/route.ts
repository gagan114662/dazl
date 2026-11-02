import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { activeOnboardingPolicy, optInOnboarding, withdrawOnboarding } from '@/lib/outreach/onboarding-policy'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'

// Onboarding/customer-success policy capture (#417). Opt-in is an explicit action by the signed-in
// workspace actor, recorded with their account id - never inferred from a cold launch policy, a verified
// signup or a payment. First activation on a real tenant remains an owner authority decision; this route
// only records what an authorized actor does.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ policy: activeOnboardingPolicy(db, user.tenantId) ?? null })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  if (body?.action === 'opt_in') {
    optInOnboarding(db, user.tenantId, user.actorId)
    await audit(user, req, { action: 'onboarding_policy.opted_in', resource: 'onboarding_policy', summary: {} })
    return NextResponse.json({ ok: true, policy: activeOnboardingPolicy(db, user.tenantId) })
  }
  if (body?.action === 'withdraw') {
    const changed = withdrawOnboarding(db, user.tenantId, user.actorId)
    if (changed) await audit(user, req, { action: 'onboarding_policy.withdrawn', resource: 'onboarding_policy', summary: {} })
    return NextResponse.json({ ok: true, changed })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
