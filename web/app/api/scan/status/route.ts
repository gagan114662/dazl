import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getJob, MAX_ATTEMPTS } from '@/lib/scan/store'
import { kickRunner } from '@/lib/scan/runner'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  // Same 404 for "does not exist" and "belongs to someone else".
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(getScanDb(), user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // polling also restarts retries and jobs reaped after a crash or restart
  // ?passive=1 is the explicit no-kick QA mode: it never starts provider work, though getJob may still reap a stale job.
  if (job.status === 'pending' && req.nextUrl.searchParams.get('passive') !== '1') after(() => kickRunner(getScanDb()))
  return NextResponse.json({ job_id: job.id, status: job.status, created_at: job.created_at, claimed_at: job.claimed_at, attempts: job.attempts, max_attempts: MAX_ATTEMPTS, lead_count: job.lead_count, quality: job.candidates === null ? null : { candidates: job.candidates, passed: job.verified, needs_review: job.needs_review, dropped: job.dropped, drop_reasons: job.drop_reasons ? JSON.parse(job.drop_reasons) : {} }, error: job.error === 'key_rejected' && (job as { funded_by?: string }).funded_by === 'trial' ? 'trial_key_invalid' : job.error, query: job.query, icp: job.icp ? JSON.parse(job.icp) : null, icp_source: job.icp_inferred === 1 ? 'inferred' : job.icp_inferred === 2 ? 'request_only' : job.icp_inferred === 0 ? 'user' : null })
}
