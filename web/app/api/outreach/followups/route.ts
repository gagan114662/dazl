import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { followupOverview } from '@/lib/outreach/followups'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(await followupOverview(await getDb(), user.tenantId))
}
