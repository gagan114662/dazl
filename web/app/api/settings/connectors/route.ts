import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { connectorStatus, recentAudit } from '@/lib/connectors/store'

// Status and lookup history only. Credentials are never returned, and there is no paid-API connector.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ connectors: connectorStatus(db, user.id), audit: recentAudit(db, user.id) })
}
