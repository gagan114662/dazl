import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { rankLeads } from '@/lib/events/prioritize'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = sqliteLeadsRead(getScanDb())
  const job = /^[a-f0-9]{24}$/.test(jobId) ? await db.getJob(user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const includeHidden = req.nextUrl.searchParams.get('all') === '1'
  const leads = await db.listLeads(user.id, job.id, 200, includeHidden) as { id: string; company_domain: string | null; score: number; fit: number | null; intent: number | null; action: number | null; signal: string }[]
  const sequences = await db.sequenceStatusByLead(user.id)
  const enr = await db.enrichmentsForLeads(user.id, leads.map(l => l.id))
  const evts = await db.eventsForLeads(user.id, leads)
  const pri = await db.leadPriorities(user.id, leads)
  const look = await db.lookalikeSignals(user.id, leads.map(l => ({ id: l.id, signal: l.signal, industry: job.industry, location: job.location })))
  const ranked = rankLeads(leads, pri)
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : await db.countHiddenLeads(user.id, job.id), leads: ranked.map(l => ({ ...l, sequence: sequences.get(l.id) ?? null, enrichments: enr[l.id] ?? [], events: evts[l.id] ?? [], priority: pri[l.id] ?? null, lookalike: look.get(l.id) ?? null })) })
}
