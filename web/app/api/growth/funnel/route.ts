import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { funnelReport } from '@/lib/growth/funnel'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { denied } from '@/lib/workspace-access'

// Dazl's own acquisition funnel (#404, lib/growth/funnel.ts): aggregate counts, rates and dollars only, never an
// email, a name or a workspace id. Owner-only: the caller must be an owner of the growth workspace named by
// DAZL_GROWTH_TENANT_ID. Unset, or any other workspace, and the route does not exist (404), so no customer workspace can
// read platform-wide figures. The tenant comes only from the session; no parameter names another one.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'billing'); if (no) return no
  const growth = process.env.DAZL_GROWTH_TENANT_ID
  if (!growth || user.tenantId !== growth) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    return NextResponse.json(await funnelReport(await getDb(), growth), { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/growth/funnel', method: 'GET', tenantId: user.tenantId, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not build the report' }, { status: 500 })
  }
}
