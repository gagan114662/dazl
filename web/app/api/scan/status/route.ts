import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getJob } from '@/lib/scan/store'
import { kickRunner } from '@/lib/scan/runner'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  // Same 404 for "does not exist" and "belongs to someone else".
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(getScanDb(), user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // polling also restarts retries and jobs reaped after a crash or restart
  if (job.status === 'pending') after(() => kickRunner(getScanDb()))
  return NextResponse.json({ job_id: job.id, status: job.status, lead_count: job.lead_count, candidates: job.candidates, verified: job.verified, error: job.error })
}
