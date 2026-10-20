import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { scanQuota } from '@/lib/plans'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const q = scanQuota(getScanDb(), user.id)
  return NextResponse.json({ plan: q.plan, scans_used: q.used, scan_limit: q.limit })
}
