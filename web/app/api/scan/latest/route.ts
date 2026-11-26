import { shownIcp } from '@/lib/scan/carry-exclusions'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { jobQueryIcp, latestQueryJob } from '@/lib/scan/store-db'

// The leads page restores the tenant's last profile from this, so a reload never loses it.
export async function GET(req?: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // #1772: with job_id the answer is that play's own scan (the Home card keys its title by play id); without it,
  // the tenant's latest, as before (the Leads page restores its last profile from this).
  const jobId = req?.nextUrl.searchParams.get('job_id') ?? null
  const job = jobId !== null ? await jobQueryIcp(await getDb(), user.tenantId, jobId) : await latestQueryJob(await getDb(), user.tenantId)
  if (!job && jobId !== null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!job) return NextResponse.json({ query: null, icp: null, icp_source: null })
  return NextResponse.json({ query: job.query, icp: shownIcp(job.icp), icp_source: job.icp_inferred === 1 ? 'inferred' : job.icp_inferred === 2 ? 'request_only' : job.icp_inferred === 3 || job.icp_inferred === 0 ? 'carried' : job.icp_inferred === 4 ? 'user' : null })
}
