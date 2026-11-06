import {leadContactContext} from '@/lib/outreach/contact-purpose-db'
import {currentnessHeld, leadWindowHeld} from '@/lib/outreach/currentness'
import { getScanDb } from '@/lib/scan/service'
import { sourceCheckForLead } from '@/lib/scan/source-review'
import { sqliteLeadsRead } from '@/lib/db/leads-read'
import { rankLeads } from '@/lib/events/prioritize'
import { getDb } from '@/lib/db/client'
import { learnedPreference, listFeedback, sourceYield, type Learned, type SourceYield } from '@/lib/scan/feedback'
import { gdeltAttribution } from '@/lib/search/news-attribution'
import { savedGradeWhy } from '@/lib/scan/leads-view'
import { fitRationale } from '@/lib/scan/score'
import { timingProofGap } from '@/lib/scan/timing-proof'
import { eventDayVerified, surfaceStoredIntent, timingUnconfirmedReason, TIMING_REQUESTED } from '@/lib/scan/scoreboard'
import { jobWindowDays } from '@/lib/scan/window'
import { leadLookalikeFit, lookalikeOf } from '@/lib/scan/lookalike-discovery'
import { classifyEntityMatch, classifyBoardMatch, qualifyEvent, withinEventWindow } from '@/lib/signals/entity-match'

// The leads of one of the workspace's scans with every evidence, timing, entity, contact and held flag the app shows
// (GET /api/leads). Moved here unchanged from the route (#392) so the scoped API (app/api/mcp) returns exactly what the
// app returns. null: no such scan in this workspace (the same answer for "does not exist" and "someone else's").
export async function leadsPayload(tenantId: string, jobId: string, includeHidden: boolean) {
  const user = { tenantId }
  const db = sqliteLeadsRead(getScanDb())
  const job = /^[a-f0-9]{24}$/.test(jobId) ? await db.getJob(user.tenantId, jobId) : undefined
  if (!job) return null
  const leads = await db.listLeads(user.tenantId, job.id, 200, includeHidden) as { id: string; source_url: string; company: string; company_domain: string | null; event_date: string | null; event_date_proof?: string | null; signal_kind?: string | null; score: number; fit: number | null; intent: number | null; action: number | null; signal: string }[]
  const sequences = await db.sequenceStatusByLead(user.tenantId)
  const enr = await db.enrichmentsForLeads(user.tenantId, leads.map(l => l.id))
  const evts = await db.eventsForLeads(user.tenantId, leads)
  const pri = await db.leadPriorities(user.tenantId, leads)
  const look = await db.lookalikeSignals(user.tenantId, leads.map(l => ({ id: l.id, signal: l.signal, industry: job.industry, location: job.location })))
  // Read-time only: preserve stored grade/rationale for inspection. Stored intent surfaces only
  // with a recognized, trigger-compatible event-date proof (#377); anything else is held at 0 and
  // labelled unconfirmed. No history is rewritten.
  const windowDays = jobWindowDays(job)
  const timingOpts = { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(job.query ?? '') }
  // #386: a lookalike scan labels each lead's fit to the supplied customers from the lead's own evidence, apart from intent:
  // "with event" only when the existing timing proof backs a current event, never from the lookalike fit itself.
  const la = lookalikeOf(job)
  const safeLeads = leads.map(l => { const t = surfaceStoredIntent(l, timingOpts); const tr = timingUnconfirmedReason(l, timingOpts)
    return {...l, stored_intent:l.intent, intent:t.intent, timing:t.timing, timing_reason:tr, day_verified:eventDayVerified(l), window_missed:tr === 'out_of_window',
    stored_why:(l as typeof l & {why?:string|null}).why ?? null,
    // #377: the fit / use-case rationale apart from timing status, and the machine timing proof's gap (null = proven).
    fit_rationale:fitRationale((l as typeof l & {why?:string|null}).why, t.timing), timing_proof_gap:timingProofGap(getScanDb(),user.tenantId,l.id),
    why:savedGradeWhy(l as typeof l & {why?:string|null}, { timing: t.timing, reason: tr }),
    currentness_held:currentnessHeld(getScanDb(),user.tenantId,l.id), window_held:leadWindowHeld(getScanDb(),user.tenantId,l.id),
    lookalike_fit:la && la !== 'unreadable' ? leadLookalikeFit(la, l as typeof l & {evidence_excerpt?:string|null}, t.timing === 'proof_backed' && !(l as typeof l & {review_reason?:string|null}).review_reason) : null} })
  const intentByLead = new Map(safeLeads.map(l => [l.id, l.intent]))
  for (const [id, p] of Object.entries(pri)) if (p) p.intent = intentByLead.get(id) ?? 0
  // #385: the tenant's own explicit verdicts on the same source and signal kind order leads inside a fit lane (shown as
  // `learned`, with why). Ordering only: a store that cannot be read gives no preference, never a drop or a gate.
  let yields: SourceYield[] = []
  try { yields = sourceYield(await listFeedback(await getDb(), user.tenantId, { activeOnly: true })) } catch { /* no preference */ }
  const learned = new Map<string, Learned>(leads.map(l => [l.id, learnedPreference(yields, l)]))
  const ranked = rankLeads(safeLeads, pri, Object.fromEntries([...learned].map(([id, p]) => [id, p.delta])))
  const via = gdeltAttribution(getScanDb(), user.tenantId, ranked.map(l => l.id))
  return { job_id: job.id, status: job.status, hidden_count: includeHidden ? 0 : await db.countHiddenLeads(user.tenantId, job.id), leads: ranked.map(l => ({ ...l, discovered_via: via.get(l.id)?.text ?? null, discovered_via_link: via.get(l.id)?.link ?? null, contact_context:leadContactContext(getScanDb(),user.tenantId,l.id), source_check: sourceCheckForLead(getScanDb(), user.tenantId, l.id), sequence: sequences.get(l.id) ?? null, enrichments: (enr[l.id] ?? []).map(e => ({ ...e, entity_status:
          e.connector === 'signals:sec-edgar'
            ? (() => { const base = classifyEntityMatch(l.company, e.label ?? '')
                return base === 'heuristic' && l.event_date && e.source_date && !withinEventWindow(e.source_date, l.event_date) ? 'unconfirmed' : base })()
          : ['signals:ashby', 'signals:greenhouse', 'signals:lever'].includes(e.connector) ? classifyBoardMatch(l.company_domain, e.source_url ?? '')
          : e.connector === 'signals:funding-round'
            ? (() => { const m = /^(.*) \(reported \d{4}-\d{2}-\d{2}\)$/.exec(e.label ?? '')
                return m ? classifyEntityMatch(l.company, m[1]) : 'unconfirmed' })()
          : null })), events: (evts[l.id] ?? []).map(ev => ({ ...ev, entity_status: qualifyEvent(l.company, l.company_domain, ev, l.event_date ?? null) })), priority: pri[l.id] ?? null, lookalike: look.get(l.id) ?? null, learned: learned.get(l.id) ?? null })) }
}
