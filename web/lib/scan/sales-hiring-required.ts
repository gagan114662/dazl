import { requestedHiringRoles, roleNeedsSourceProof } from './hiring-role-match.ts'
// Whether a request needs the sales-hiring proof. Kept apart from sales-hiring-gate.ts on purpose: held-state.ts (reached from the
// browser bundle through the outreach follow-up client) imports this, and it must stay free of server-only modules (db, network, crawl).
import { isGtmRole } from '../signals/ats-gtm.ts'
import { needsEventBeyondHiring } from '../search/page-class.ts'
import { compileTargeting, roleAlternatives, type Condition, type PlanNode } from './targeting.ts'

const HIRING_WORDS = /\bhir(?:e|es|ed|ing)\b|\brecruit\w*|\b(?:new|open|several|two|three|\d+)\s+(?:sales\s+|gtm\s+)?(?:role|position|opening)s?\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)/i

export function salesHiringRequired(query: string | null | undefined, icp: string | null | undefined): boolean {
  let signals: string[] = []
  try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) signals = j!.signals.filter((x): x is string => typeof x === 'string') } catch { /* no profile */ }
  // The hiring word and the sales / GTM role must come from the user's request (whole: their own words are one intent, however they punctuate "...hiring a Sr.
  // Account Executive" or "hiring; sales, BD, AEs") with at most ONE signal of the model-inferred profile. What is no longer allowed is joining the signals WITH EACH
  // OTHER: "Hired lateral partners recently" and an unrelated "Press release about practice area growth" (the word "growth") made a law-firm request that never
  // mentions sales hiring "need the sales-hiring proof": every verified lead of a model-inferred profile was default-denied (lib/scan/held-state.ts) and the
  // matrix read 0 ready. Everything else is as before (request + one signal, a signal alone, the request alone).
  const q = query ?? ''
  const parts = [q, ...signals, ...signals.map(s => `${q} . ${s}`)].filter(p => p.trim() !== '')
  const sameClause = parts.some(p => HIRING_WORDS.test(p) && isGtmRole(p.replace(/\b(?:hir(?:e|es|ed|ing)|recruit\w*)\b/gi, ' ')))
  return requestedHiringRoles(query, icp).some(roleNeedsSourceProof) || needsEventBeyondHiring(signals, query ?? '') && sameClause
}

// #380 / #204 Test B: how the request joins the event half and the sales-hiring half, read from its compiled targeting plan (targeting.ts).
// Returns the two branches only when the plan holds ONE OR (not under a NOT) of exactly two plain conditions: a funding / event condition and a
// sales / GTM hiring condition (an open role, or a completed hire: hire_made, #876) ("raised seed funding or made their first sales hire"). Anything else - the AND wording, an ambiguous and/or
// (compiled as AND), a third branch, a negation, an unreadable profile or plan - returns null: the gate keeps requiring both halves.
export interface SalesGateOr { event: Condition; hiring: Condition; newRoles?: Condition[] }
export function salesGateOr(query: string | null | undefined, icp: string | null | undefined): SalesGateOr | null {
  try {
    if (icp) { const j = JSON.parse(icp) as unknown; if (!j || typeof j !== 'object' || Array.isArray(j)) return null }
    const ors: PlanNode[] = []
    const walk = (n: PlanNode | null) => { if (!n) return; if (n.op === 'or') ors.push(n); else if (n.op === 'and') n.of.forEach(walk) }
    walk(compileTargeting(query, icp).root)
    if (ors.length !== 1) return null
    const of = (ors[0] as { of: PlanNode[] }).of
    if (of.length < 2 || !of.every(n => n.op === 'cond')) return null
    const cs = of.map(n => (n as { cond: Condition }).cond)
    // #1122 (case 1): "A, B, C, or D" lists more than two branches. Extra branches are allowed only when each is another funding/event
    // condition or a "new <role>" (new_role) sales condition: the gate checks those too (newRoles); any other third branch keeps both halves required.
    if (cs.length > 2) {
      const ev = cs.filter(c => c.kind === 'funding' || c.kind === 'event'), hi = cs.filter(c => c.kind === 'hiring' && (!c.role || roleAlternatives(c.role).some(isGtmRole)))
      const nr = cs.filter(c => c.kind === 'hire_made' && c.new_role && isGtmRole(c.role ?? ''))
      if (ev.length !== 1 || hi.length !== 1 || ev.length + hi.length + nr.length !== cs.length) return null
      if ([...ev, ...hi, ...nr].some(c => c.relative_to || c.clock_conflict)) return null
      return { event: ev[0], hiring: hi[0], newRoles: nr }
    }
    // #876: "made their first sales hire" compiles to hire_made (a completed hire), still the sales-hiring branch of the OR. The plan's own clause
    // proof (targeting-proof.ts) then needs a source showing the completed hire; an open posting does not prove it.
    // #878 (main): a clause whose stated clocks conflict never forms the OR.
    const event = cs.find(c => c.kind === 'funding' || c.kind === 'event'), hiring = cs.find(c => (c.kind === 'hiring' || c.kind === 'hire_made') && (!c.role || (c.kind === 'hiring' ? roleAlternatives(c.role).some(isGtmRole) : isGtmRole(c.role))))
    return event && hiring && !event.relative_to && !hiring.relative_to && !event.clock_conflict && !hiring.clock_conflict ? { event, hiring } : null
  } catch { return null }
}
