import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied, stale } from '@/lib/workspace-access'
import { exportTenant } from '@/lib/tenant/lifecycle'
import { record } from '@/lib/audit'

// Full account export (every tenant-owned table, stored credentials redacted). Downloading everything the
// account holds needs fresh proof it is still the owner at the keyboard, and the export itself is audited.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'export'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = await getDb()
  const x = await exportTenant(db, user.tenantId)
  await record(db, { tenantId: user.tenantId, actorId: user.actorId, action: 'tenant.export', resourceType: 'tenant', resourceId: user.tenantId, summary: { tables: Object.keys(x.tables).length } })
  return new NextResponse(JSON.stringify(x, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="dazl-export-${user.tenantId}.json"`,
    },
  })
}
