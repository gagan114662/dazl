import { sequenceStatusByLead } from '@/lib/outreach/sequences'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { countHiddenLeads, getJob, listLeads } from '@/lib/scan/store'
import { enrichmentsForLeads } from '@/lib/connectors/store'
import { eventsForLeads } from '@/lib/events/store'
import { leadPriorities, rankLeads } from '@/lib/events/prioritize'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = getScanDb()
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(db, user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const includeHidden = req.nextUrl.searchParams.get('all') === '1'
  const leads = listLeads(db, user.id, job.id, 200, includeHidden) as { id: string; company_domain: string | null; score: number; fit: number | null; intent: number | null; action: number | null }[]
  const sequences = sequenceStatusByLead(db,user.id)
  const enr = enrichmentsForLeads(db, user.id, leads.map(l => l.id))
  const evts = eventsForLeads(db, user.id, leads)
  const pri = leadPriorities(db, user.id, leads)
  const ranked = rankLeads(leads, pri)
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : countHiddenLeads(db, user.id, job.id), leads: ranked.map(l => ({ ...l, sequence: sequences.get(l.id) ?? null, enrichments: enr[l.id] ?? [], events: evts[l.id] ?? [], priority: pri[l.id] ?? null })) })
}
