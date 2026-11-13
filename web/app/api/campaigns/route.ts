import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { campaignsLimit, listCampaigns } from '@/lib/outreach/campaigns'
import { getDb } from '@/lib/db/client'
import { historyJobs } from '@/lib/scan/history-jobs'
import { campaignStatus } from '@/lib/run-status'

// The campaign view: one row per recent search with its funnel and next action. Read-only, the user's own data only.
// ?limit=N (1-20, default 10): the Leads history (#1136) asks for 20, the size of its own list (lib/scan/history-jobs.ts),
// so every past scan it shows has its current status.
export async function GET(req?: NextRequest) {
  const limit = campaignsLimit(req?.nextUrl?.searchParams.get('limit') ?? null)
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // Each row's run status is the same recorded outcome the Leads history and the campaign page show (one record per
  // scan from historyJobs, which carries the extraction diagnostic); a row not in that read keeps its own next action.
  const jobs = new Map((await historyJobs(await getDb(), user.tenantId)).map(j => [j.id, j]))
  return NextResponse.json({ campaigns: listCampaigns(getScanDb(), user.tenantId, limit).map(c => campaignStatus(c, (jobs.get(c.id) as never) ?? null)) })
}
