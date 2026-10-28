import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { connectorStatus, readRecentAudit } from '@/lib/connectors/store'

// Status and lookup history only. Credentials are never returned, and there is no paid-API connector.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  return NextResponse.json({ connectors: await connectorStatus(db, user.id), audit: await readRecentAudit(db, user.id) })
}
