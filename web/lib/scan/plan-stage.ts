// The typed query plan applied to a finished verification (#380): what the request asked for, each kept lead's state per condition (true / false / UNKNOWN, with the proof that
// made a clause true), and the request's hard exclusions ("excluding X") enforced in code. A condition is true only on its own proof - a lead's verbatim quote, URL and the
// lead's verified date, bound to the company (the lead passed the verifier) - and a company's conditions are joined across its kept leads (a funding article and a hiring posting
// for the same company each prove their own clause). Nothing here widens, relaxes or re-grades: a lead the plan cannot prove stays where the verifier put it, and the report says
// which conditions are unproven. Pure; no model call.
import { compilePlan, describePlan, evaluatePlan, kindOf, widenOptions, type Evaluation, type Pred, type Proof, type QueryPlan, type Tri } from './query-plan.ts'
import { dedupKey } from './evidence.ts'

export interface PlanLead { company: string; name: string; signal: string; excerpt: string; source_url: string; event_date: string | null }
export interface PlanReview extends PlanLead { review_reason: string }
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const facts = (p: Pred): { id: string; kind: string }[] => p.op === 'fact' ? [{ id: p.id, kind: p.kind }] : p.op === 'not' ? facts(p.of) : p.of.flatMap(facts)

export interface PlanReport { request: string; plan: string; ambiguities: string[]; widening_options: string[]; excluded: { company: string; matched: string }[]; leads: { company: string; state: Tri; conditions: { text: string; state: Tri; missing: string | null; proof: { url: string; date: string | null } | null }[] }[] }
export function applyQueryPlan<L extends PlanLead, R extends PlanReview>(request: string, where: string[] | undefined, leads: L[], review: R[]): { leads: L[]; review: R[]; excluded: number; report: PlanReport | null; plan: QueryPlan } {
  const plan = compilePlan(request, { where })
  const ids = facts(plan.hard)
  // no readable event condition and no exclusions: the plan has nothing to add
  if (ids.length === 0 && plan.exclude.length === 0) return { leads, review, excluded: 0, report: null, plan }
  const excl = (l: PlanLead) => plan.exclude.find(x => x && (norm(l.company).includes(norm(x)) || norm(l.name).includes(norm(x)) || norm(`${l.signal} ${l.excerpt}`).includes(norm(x))))
  const kept: L[] = [], excluded: { company: string; matched: string }[] = []
  for (const l of leads) { const m = excl(l); if (m) excluded.push({ company: l.company, matched: m }); else kept.push(l) }
  // conditions per company, joined across its kept leads
  const byCompany = new Map<string, L[]>(); for (const l of kept) { const k = dedupKey(l); byCompany.set(k, [...(byCompany.get(k) ?? []), l]) }
  const out: PlanReport['leads'] = []
  for (const [, group] of byCompany) {
    const f: Record<string, { state: Tri; proof?: Proof | null }> = {}
    for (const { id, kind } of ids) {
      const l = group.find(x => kindOf(`${x.signal} ${x.excerpt}`) === kind)
      if (l) f[id] = { state: 'true', proof: { url: l.source_url, quote: l.excerpt, date: l.event_date, entity_bound: true } }
    }
    const ev: Evaluation = evaluatePlan(plan, f, { name: group[0].company })
    out.push({ company: group[0].company, state: ev.state, conditions: ev.clauses.map(c => ({ text: c.text, state: c.state, missing: c.missing, proof: c.proof ? { url: c.proof.url, date: c.proof.date } : null })) })
  }
  const report: PlanReport = { request: request.slice(0, 300), plan: describePlan(plan.hard), ambiguities: plan.ambiguities, widening_options: widenOptions(plan), excluded, leads: out.slice(0, 40) }
  return { leads: kept, review, excluded: excluded.length, report, plan }
}
