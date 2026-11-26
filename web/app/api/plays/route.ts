import { NextRequest, NextResponse } from 'next/server'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { workspacePlays } from '@/lib/workspace-plays'
import { systemMailAvailable } from '@/lib/system-mail'
import { trialPrincipal, trialQaExempt } from '@/lib/billing/trial-budget'

// #1471: the workspace's plays, the one list Home ("Your plays") and the Plays page both show (lib/workspace-plays.ts).
// Read-only, tenant-scoped. watches/monitors carry the repeating plays' details for the Plays page; emails says whether
// this host sends the new-leads email after a run (as GET /api/watch). A store that cannot be read answers 503, so neither
// page ever shows "no plays" for a list it could not read.
export async function GET(req?: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  try {
    const db = await getDb()
    const [out, principal] = await Promise.all([workspacePlays(db, user.tenantId), trialPrincipal(db, user)])
    return NextResponse.json({ ...out, emails: systemMailAvailable(), trial_exempt: principal !== null && trialQaExempt(principal.email) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/plays', method: 'GET', tenantId: user.tenantId, requestId: req ? requestIdOf(req) : undefined })
    return NextResponse.json({ error: 'Could not read your plays right now' }, { status: 503 })
  }
}
