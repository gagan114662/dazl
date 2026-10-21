import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { countHiddenLeads, getJob, listLeads } from '@/lib/scan/store'
import { enrichmentsForLeads } from '@/lib/connectors/store'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = getScanDb()
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(db, user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const includeHidden = req.nextUrl.searchParams.get('all') === '1'
  const leads = listLeads(db, user.id, job.id, 200, includeHidden) as { id: string }[]
  const enr = enrichmentsForLeads(db, user.id, leads.map(l => l.id))
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : countHiddenLeads(db, user.id, job.id), leads: leads.map(l => ({ ...l, enrichments: enr[l.id] ?? [] })) })
}
