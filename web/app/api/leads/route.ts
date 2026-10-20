import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getJob, listLeads } from '@/lib/scan/store'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = getScanDb()
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(db, user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ job_id: job.id, status: job.status, leads: listLeads(db, user.id, job.id) })
}
