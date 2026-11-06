import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sourceMetrics } from '@/lib/scan/source-metrics'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // getDb(): on SQLite the store getDb opens has run every module's migrate (incl. migrateScan); on Postgres the schema is the migrations.
  return NextResponse.json(await sourceMetrics(await getDb(), user.tenantId))
}
