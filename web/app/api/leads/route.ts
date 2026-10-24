import {leadContactContext} from '@/lib/outreach/contact-purpose-db'
import {currentnessHeld} from '@/lib/outreach/currentness'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sourceCheckForLead } from '@/lib/scan/source-review'
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
  // Read-time only: preserve stored grade/rationale for inspection, but never
  // rank legacy unsupported timing as a live need. No history is rewritten.
  const safeLeads = leads.map(l => ({...l, stored_intent:l.intent, intent:0,
    stored_why:(l as typeof l & {why?:string|null}).why ?? null,
    why:(l as typeof l & {why?:string|null}).why ? 'Event timing and current need are unconfirmed. Saved grades are historical, not a currentness verdict.' : 'This lead has no saved grade. Event timing and current need are unconfirmed.',
    currentness_held:currentnessHeld(getScanDb(),user.id,l.id)}))
  for (const p of Object.values(pri)) if (p) p.intent=0
  const ranked = rankLeads(safeLeads, pri)
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : await db.countHiddenLeads(user.id, job.id), leads: ranked.map(l => ({ ...l, contact_context:leadContactContext(getScanDb(),user.id,l.id), source_check: sourceCheckForLead(getScanDb(), user.id, l.id), sequence: sequences.get(l.id) ?? null, enrichments: (enr[l.id] ?? []).map(e => ({ ...e, entity_status:
          e.connector === 'signals:sec-edgar'
            ? (() => { const base = classifyEntityMatch(l.company, e.label ?? '')
                return base === 'heuristic' && l.event_date && e.source_date && !withinEventWindow(e.source_date, l.event_date) ? 'unconfirmed' : base })()
          : ['signals:ashby', 'signals:greenhouse', 'signals:lever'].includes(e.connector) ? classifyBoardMatch(l.company_domain, e.source_url ?? '')
          : e.connector === 'signals:funding-round'
            ? (() => { const m = /^(.*) \(reported \d{4}-\d{2}-\d{2}\)$/.exec(e.label ?? '')
                return m ? classifyEntityMatch(l.company, m[1]) : 'unconfirmed' })()
          : null })), events: (evts[l.id] ?? []).map(ev => ({ ...ev, entity_status: qualifyEvent(l.company, l.company_domain, ev, l.event_date ?? null) })), priority: pri[l.id] ?? null, lookalike: look.get(l.id) ?? null })) })
}
