import { NextRequest, NextResponse } from 'next/server'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { leadsTable } from '@/lib/leads/table'

// #1038: the Leads table - the workspace's leads across scans, sorted by fit or date, 50 a page. Read-only, tenant-scoped;
// a store that cannot be read answers 503, never an empty table.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  try {
    const q = req.nextUrl.searchParams
    return NextResponse.json(leadsTable(getScanDb(), user.tenantId, { sort: q.get('sort'), page: q.get('page') }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/leads/table', method: 'GET', tenantId: user.tenantId, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not read your leads right now' }, { status: 503 })
  }
}
