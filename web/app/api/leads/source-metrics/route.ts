import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { migrateScan } from '@/lib/scan/store'
import { sourceMetrics } from '@/lib/scan/source-metrics'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  migrateScan(db)
  return NextResponse.json(sourceMetrics(db, user.tenantId))
}
