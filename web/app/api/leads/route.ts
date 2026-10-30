import {leadContactContext} from '@/lib/outreach/contact-purpose-db'
import {currentnessHeld, leadWindowHeld} from '@/lib/outreach/currentness'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sourceCheckForLead } from '@/lib/scan/source-review'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { rankLeads } from '@/lib/events/prioritize'
import { gdeltAttribution } from '@/lib/search/news-attribution'
import { savedGradeWhy } from '@/lib/scan/leads-view'
import { timingOf } from '@/lib/scan/timing-proof'
import { classifyEntityMatch, classifyBoardMatch, qualifyEvent, withinEventWindow } from '@/lib/signals/entity-match'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = sqliteLeadsRead(getScanDb())
  const job = /^[a-f0-9]{24}$/.test(jobId) ? await db.getJob(user.tenantId, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const includeHidden = req.nextUrl.searchParams.get('all') === '1'
  const leads = await db.listLeads(user.tenantId, job.id, 200, includeHidden) as { id: string; company: string; company_domain: string | null; event_date: string | null; score: number; fit: number | null; intent: number | null; action: number | null; signal: string }[]
  const sequences = await db.sequenceStatusByLead(user.tenantId)
  const enr = await db.enrichmentsForLeads(user.tenantId, leads.map(l => l.id))
  const evts = await db.eventsForLeads(user.tenantId, leads)
  const pri = await db.leadPriorities(user.tenantId, leads)
  const look = await db.lookalikeSignals(user.tenantId, leads.map(l => ({ id: l.id, signal: l.signal, industry: job.industry, location: job.location })))
  // Read-time only; no history is rewritten. Fit/use-case rationale is kept as saved and shown as such. Timing is judged separately from verified proof
  // (lib/scan/timing-proof.ts): the saved intent counts, and ranks, only when the quote itself ties a stated event day to this company; otherwise it is
  // unknown/held and ranks as 0. A model grade or a publication date alone never upgrades timing.
  const safeLeads = leads.map(l => {
    const x = l as typeof l & { why?: string | null; evidence_excerpt?: string | null; date_status?: string | null; confidence?: number | null; review_reason?: string | null; quarantined_at?: number | null }
    const currentness_held = currentnessHeld(getScanDb(), user.tenantId, l.id), window_held = leadWindowHeld(getScanDb(), user.tenantId, l.id)
    const timing = timingOf({ company: l.company, evidence_excerpt: x.evidence_excerpt, event_date: l.event_date, date_status: x.date_status, confidence: x.confidence, review_reason: x.review_reason, quarantined_at: x.quarantined_at, currentness_held, window_held })
    return { ...l, stored_intent: l.intent, intent: timing.supported ? l.intent : 0, timing, fit_rationale: x.why ?? null,
      stored_why: x.why ?? null, why: x.why ?? savedGradeWhy(x), currentness_held, window_held }
  })
  for (const l of safeLeads) { const p = pri[l.id]; if (p && !l.timing.supported) p.intent = 0 }
  const ranked = rankLeads(safeLeads, pri)
  const via = gdeltAttribution(getScanDb(), user.tenantId, ranked.map(l => l.id))
  return NextResponse.json({ job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : await db.countHiddenLeads(user.tenantId, job.id), leads: ranked.map(l => ({ ...l, discovered_via: via.get(l.id)?.text ?? null, discovered_via_link: via.get(l.id)?.link ?? null, contact_context:leadContactContext(getScanDb(),user.tenantId,l.id), source_check: sourceCheckForLead(getScanDb(), user.tenantId, l.id), sequence: sequences.get(l.id) ?? null, enrichments: (enr[l.id] ?? []).map(e => ({ ...e, entity_status:
          e.connector === 'signals:sec-edgar'
            ? (() => { const base = classifyEntityMatch(l.company, e.label ?? '')
                return base === 'heuristic' && l.event_date && e.source_date && !withinEventWindow(e.source_date, l.event_date) ? 'unconfirmed' : base })()
          : ['signals:ashby', 'signals:greenhouse', 'signals:lever'].includes(e.connector) ? classifyBoardMatch(l.company_domain, e.source_url ?? '')
          : e.connector === 'signals:funding-round'
            ? (() => { const m = /^(.*) \(reported \d{4}-\d{2}-\d{2}\)$/.exec(e.label ?? '')
                return m ? classifyEntityMatch(l.company, m[1]) : 'unconfirmed' })()
          : null })), events: (evts[l.id] ?? []).map(ev => ({ ...ev, entity_status: qualifyEvent(l.company, l.company_domain, ev, l.event_date ?? null) })), priority: pri[l.id] ?? null, lookalike: look.get(l.id) ?? null })) })
}
