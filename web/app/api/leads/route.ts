import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { rankLeads } from '@/lib/events/prioritize'
import { classifyEntityMatch, classifyBoardMatch, qualifyEvent, withinEventWindow } from '@/lib/signals/entity-match'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = sqliteLeadsRead(getScanDb())
  const job = /^[a-f0-9]{24}$/.test(jobId) ? await db.getJob(user.id, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const includeHidden = req.nextUrl.searchParams.get('all') === '1'
  const leads = await db.listLeads(user.id, job.id, 200, includeHidden) as { id: string; company: string; company_domain: string | null; event_date: string | null; score: number; fit: number | null; intent: number | null; action: number | null; signal: string }[]
  const sequences = await db.sequenceStatusByLead(user.id)
  const enr = await db.enrichmentsForLeads(user.id, leads.map(l => l.id))
  const evts = await db.eventsForLeads(user.id, leads)
  const pri = await db.leadPriorities(user.id, leads)
  const look = await db.lookalikeSignals(user.id, leads.map(l => ({ id: l.id, signal: l.signal, industry: job.industry, location: job.location })))
  const ranked = rankLeads(leads, pri)
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : await db.countHiddenLeads(user.id, job.id), leads: ranked.map(l => ({ ...l, sequence: sequences.get(l.id) ?? null, enrichments: (enr[l.id] ?? []).map(e => ({ ...e, entity_status:
          e.connector === 'signals:sec-edgar'
            ? (() => { const base = classifyEntityMatch(l.company, e.label ?? '')
                return base === 'heuristic' && l.event_date && e.source_date && !withinEventWindow(e.source_date, l.event_date) ? 'unconfirmed' : base })()
          : ['signals:ashby', 'signals:greenhouse', 'signals:lever'].includes(e.connector) ? classifyBoardMatch(l.company_domain, e.source_url ?? '')
          : e.connector === 'signals:funding-round'
            ? (() => { const m = /^(.*) \(reported \d{4}-\d{2}-\d{2}\)$/.exec(e.label ?? '')
                return m ? classifyEntityMatch(l.company, m[1]) : 'unconfirmed' })()
          : null })), events: (evts[l.id] ?? []).map(ev => ({ ...ev, entity_status: qualifyEvent(l.company, l.company_domain, ev, l.event_date ?? null) })), priority: pri[l.id] ?? null, lookalike: look.get(l.id) ?? null })) })
}
