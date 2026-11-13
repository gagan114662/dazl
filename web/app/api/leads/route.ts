import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { leadsViewForJob } from '@/lib/scan/leads-view-server'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = sqliteLeadsRead(getScanDb())
  const job = /^[a-f0-9]{24}$/.test(jobId) ? await db.getJob(user.tenantId, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // the per-scan view lives in lib/scan/leads-view-server.ts so Home's Ready tile counts with the same holds (#1040)
  return NextResponse.json(await leadsViewForJob(user.tenantId, job, req.nextUrl.searchParams.get('all') === '1'))
}
