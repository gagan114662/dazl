import {readLeadContactContext} from '@/lib/outreach/contact-purpose-db'
import {readCurrentnessHeld, readLeadWindowHeld} from '@/lib/outreach/currentness'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { readSourceCheckForLead } from '@/lib/scan/source-review'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { pgLeadsRead } from '@/lib/db/leads-read-pg'
import { getDb } from '@/lib/db/client'
import { rankLeads } from '@/lib/events/prioritize'
import { readGdeltAttribution } from '@/lib/search/news-attribution'
import { savedGradeWhy } from '@/lib/scan/leads-view'
import { classifyEntityMatch, classifyBoardMatch, qualifyEvent, withinEventWindow } from '@/lib/signals/entity-match'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  // Every read on the shared store (#354): Postgres when the app runs on it (the leads reads through pgLeadsRead), else
  // the app's SQLite handle, which is the connection getDb() wraps.
  const store = await getDb()
  const db = store.kind === 'pg' ? pgLeadsRead((store as unknown as { pool: Parameters<typeof pgLeadsRead>[0] }).pool) : sqliteLeadsRead(getScanDb())
  const job = /^[a-f0-9]{24}$/.test(jobId) ? await db.getJob(user.tenantId, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const includeHidden = req.nextUrl.searchParams.get('all') === '1'
  const leads = await db.listLeads(user.tenantId, job.id, 200, includeHidden) as { id: string; company: string; company_domain: string | null; event_date: string | null; score: number; fit: number | null; intent: number | null; action: number | null; signal: string }[]
  const sequences = await db.sequenceStatusByLead(user.tenantId)
  const enr = await db.enrichmentsForLeads(user.tenantId, leads.map(l => l.id))
  const evts = await db.eventsForLeads(user.tenantId, leads)
  const pri = await db.leadPriorities(user.tenantId, leads)
  const look = await db.lookalikeSignals(user.tenantId, leads.map(l => ({ id: l.id, signal: l.signal, industry: job.industry, location: job.location })))
  // Read-time only: preserve stored grade/rationale for inspection, but never
  // rank legacy unsupported timing as a live need. No history is rewritten.
  const holds = await Promise.all(leads.map(async l => [await readCurrentnessHeld(store, user.tenantId, l.id), await readLeadWindowHeld(store, user.tenantId, l.id)] as const))
  const safeLeads = leads.map((l, i) => ({...l, stored_intent:l.intent, intent:0,
    stored_why:(l as typeof l & {why?:string|null}).why ?? null,
    why:savedGradeWhy(l as typeof l & {why?:string|null}),
    currentness_held:holds[i][0], window_held:holds[i][1]}))
  for (const p of Object.values(pri)) if (p) p.intent=0
  const ranked = rankLeads(safeLeads, pri)
  const via = await readGdeltAttribution(store, user.tenantId, ranked.map(l => l.id))
  const contexts = new Map(await Promise.all(ranked.map(async l => [l.id, [await readLeadContactContext(store, user.tenantId, l.id), await readSourceCheckForLead(store, user.tenantId, l.id)]] as const)))
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : await db.countHiddenLeads(user.tenantId, job.id), leads: ranked.map(l => ({ ...l, discovered_via: via.get(l.id)?.text ?? null, discovered_via_link: via.get(l.id)?.link ?? null, contact_context:contexts.get(l.id)![0], source_check: contexts.get(l.id)![1], sequence: sequences.get(l.id) ?? null, enrichments: (enr[l.id] ?? []).map(e => ({ ...e, entity_status:
          e.connector === 'signals:sec-edgar'
            ? (() => { const base = classifyEntityMatch(l.company, e.label ?? '')
                return base === 'heuristic' && l.event_date && e.source_date && !withinEventWindow(e.source_date, l.event_date) ? 'unconfirmed' : base })()
          : ['signals:ashby', 'signals:greenhouse', 'signals:lever'].includes(e.connector) ? classifyBoardMatch(l.company_domain, e.source_url ?? '')
          : e.connector === 'signals:funding-round'
            ? (() => { const m = /^(.*) \(reported \d{4}-\d{2}-\d{2}\)$/.exec(e.label ?? '')
                return m ? classifyEntityMatch(l.company, m[1]) : 'unconfirmed' })()
          : null })), events: (evts[l.id] ?? []).map(ev => ({ ...ev, entity_status: qualifyEvent(l.company, l.company_domain, ev, l.event_date ?? null) })), priority: pri[l.id] ?? null, lookalike: look.get(l.id) ?? null })) })
}
