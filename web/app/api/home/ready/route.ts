import { NextRequest, NextResponse } from 'next/server'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { requireUser } from '@/lib/scan/service'
import { homeReady } from '@/lib/outreach/home-ready'

// #1040: Home's "Ready leads" tile - leads found in the last 30 days that the Leads page shows ready. Read-only, tenant-scoped,
// fetched apart from /api/home/results (it runs the Leads page's per-lead checks); a store that cannot be read answers 503 so
// the tile says so, never a 0.
export async function GET(req?: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  try {
    return NextResponse.json(await homeReady(user.tenantId), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/home/ready', method: 'GET', tenantId: user.tenantId, requestId: req ? requestIdOf(req) : undefined })
    return NextResponse.json({ error: 'Could not check your ready leads right now' }, { status: 503 })
  }
}
