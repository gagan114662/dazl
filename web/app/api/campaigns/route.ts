import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { listCampaigns } from '@/lib/outreach/campaigns'
import { getDb } from '@/lib/db/client'
import { historyJobs } from '@/lib/scan/history-jobs'
import { campaignStatus } from '@/lib/run-status'

// The campaign view: one row per recent search with its funnel and next action. Read-only, the user's own data only.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // Each row's run status is the same recorded outcome the Leads history and the campaign page show (one record per
  // scan from historyJobs, which carries the extraction diagnostic); a row not in that read keeps its own next action.
  const jobs = new Map((await historyJobs(await getDb(), user.tenantId)).map(j => [j.id, j]))
  return NextResponse.json({ campaigns: listCampaigns(getScanDb(), user.tenantId).map(c => campaignStatus(c, (jobs.get(c.id) as never) ?? null)) })
}
