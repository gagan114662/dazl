import { requestedHiringRoles, roleNeedsSourceProof } from './hiring-role-match.ts'
// Whether a request needs the sales-hiring proof. Kept apart from sales-hiring-gate.ts on purpose: held-state.ts (reached from the
// browser bundle through the outreach follow-up client) imports this, and it must stay free of server-only modules (db, network, crawl).
import { isGtmRole } from '../signals/ats-gtm.ts'
import { needsEventBeyondHiring } from '../search/page-class.ts'
import { compileTargeting, type Condition, type PlanNode } from './targeting.ts'

const HIRING_WORDS = /\bhir(?:e|es|ed|ing)\b|\brecruit\w*|\b(?:new|open|several|two|three|\d+)\s+(?:sales\s+|gtm\s+)?(?:role|position|opening)s?\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)/i

export function salesHiringRequired(query: string | null | undefined, icp: string | null | undefined): boolean {
  let signals: string[] = []
  try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) signals = j!.signals.filter((x): x is string => typeof x === 'string') } catch { /* no profile */ }
  const text = [...signals, query ?? ''].join(' . ')
  return requestedHiringRoles(query, icp).some(roleNeedsSourceProof) || needsEventBeyondHiring(signals, query ?? '') && HIRING_WORDS.test(text) && isGtmRole(text.replace(/\b(?:hir(?:e|es|ed|ing)|recruit\w*)\b/gi, ' '))
}

// #380 / #204 Test B: how the request joins the event half and the sales-hiring half, read from its compiled targeting plan (targeting.ts).
// Returns the two branches only when the plan holds ONE OR (not under a NOT) of exactly two plain conditions: a funding / event condition and a
// sales / GTM hiring condition (an open role, or a completed hire: hire_made, #876) ("raised seed funding or made their first sales hire"). Anything else - the AND wording, an ambiguous and/or
// (compiled as AND), a third branch, a negation, an unreadable profile or plan - returns null: the gate keeps requiring both halves.
export interface SalesGateOr { event: Condition; hiring: Condition }
export function salesGateOr(query: string | null | undefined, icp: string | null | undefined): SalesGateOr | null {
  try {
    if (icp) { const j = JSON.parse(icp) as unknown; if (!j || typeof j !== 'object' || Array.isArray(j)) return null }
    const ors: PlanNode[] = []
    const walk = (n: PlanNode | null) => { if (!n) return; if (n.op === 'or') ors.push(n); else if (n.op === 'and') n.of.forEach(walk) }
    walk(compileTargeting(query, icp).root)
    if (ors.length !== 1) return null
    const of = (ors[0] as { of: PlanNode[] }).of
    if (of.length !== 2 || !of.every(n => n.op === 'cond')) return null
    const cs = of.map(n => (n as { cond: Condition }).cond)
    // #876: "made their first sales hire" compiles to hire_made (a completed hire), still the sales-hiring branch of the OR. The plan's own clause
    // proof (targeting-proof.ts) then needs a source showing the completed hire; an open posting does not prove it.
    const event = cs.find(c => c.kind === 'funding' || c.kind === 'event'), hiring = cs.find(c => (c.kind === 'hiring' || c.kind === 'hire_made') && (!c.role || isGtmRole(c.role)))
    return event && hiring && !event.relative_to && !hiring.relative_to ? { event, hiring } : null
  } catch { return null }
}
