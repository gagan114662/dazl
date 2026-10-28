import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { listCampaigns } from '@/lib/outreach/campaigns'

// The campaign view: one row per recent search with its funnel and next action. Read-only, the user's own data only.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ campaigns: listCampaigns(getScanDb(), user.id) })
}
