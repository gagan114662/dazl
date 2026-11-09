// The other half of "seed funding AND hiring sales". A candidate that came from a public job board proves the HIRING half (a dated sales / GTM posting) but its quote is a job ad, which
// never shows a funding round - the sales-hiring gate rightly holds it as no_event_evidence. A funding-news candidate has the reverse gap and is checked against the boards by the gate.
// This closes the first gap WITHOUT a new kind of proof: for the few companies in that position it only decides what to SEARCH for; whatever the news search returns goes through the same
// extraction and the same verifier (quote on the page, identity, date window) as every other candidate, and the gate then merges the verified funding quote with the posting.
import { affirmativeSalesHiring, quoteShowsCompletedHire, quoteShowsEvent, requestAsksFunding, requestedStage, salesHiringRequired } from './sales-hiring-gate.ts'
import { salesGateOr } from './sales-hiring-required.ts'
import { mentionsFunding } from '../search/page-class.ts'
import { companyKey } from './evidence.ts'

export const MAX_CORROBORATE = 3
export interface CorroTarget { company: string; query: string; branch?: 'event' | 'hiring' }
type CorroLead = { company: string; excerpt: string; signal: string }
// `others` (the scan's earlier, non-board candidates) is read only when the compiled plan is an OR (salesGateOr); the AND path never looks at it.
export function corroborationTargets(job: { query?: string | null; icp?: string | null }, leads: CorroLead[], others: CorroLead[] = []): CorroTarget[] {
  if (!salesHiringRequired(job.query, job.icp) || !requestAsksFunding(job.query, job.icp)) return []
  const stage = requestedStage(job.query, job.icp)
  const out: CorroTarget[] = [], seen = new Set<string>()
  for (const l of leads) {
    const key = companyKey(l.company)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (quoteShowsEvent(l.excerpt, l.signal, true, l.company, stage)) continue   // already shows the funding half
    out.push({ company: l.company, query: `"${l.company.replace(/["\n]/g, ' ').trim()}" raised ${stage ? `${stage} ` : ''}funding round`.slice(0, 150) })
    if (out.length >= MAX_CORROBORATE) break
  }
  return orTargets(job, out.length, stage, [...leads, ...others]) ?? out
}

// #380 / #204 Test B ("seed funding OR first sales hire"): a board posting that shows sales hiring already proves its branch, so a funding search for it is
// spent on nothing. Under an OR plan the SAME number of searches the AND rule would have made (never more: `slots`, itself <= MAX_CORROBORATE) goes to
// candidates whose own quote proves NEITHER branch, each searched for the branch it claims: a funding claim gets the funding search above, a hiring claim
// gets a sales-hiring search. A candidate claiming neither is not searched. Returns null (keep the AND targets) when the plan is not an OR.
const HIRING_CLAIM = /\bhir(?:e|es|ed|ing)\b|\brecruit\w*/i
const claimedBranch = (t: string): 'event' | 'hiring' | null => mentionsFunding(t) ? 'event' : HIRING_CLAIM.test(t) ? 'hiring' : null
function orTargets(job: { query?: string | null; icp?: string | null }, slots: number, stage: ReturnType<typeof requestedStage>, leads: CorroLead[]): CorroTarget[] | null {
  const or = salesGateOr(job.query, job.icp)
  if (!or) return null
  // #876: a completed-hire branch ("made their first sales hire") is proven only by a report that the hire was made (quoteShowsCompletedHire), never by
  // an open vacancy: a candidate whose quote only shows open hiring still needs that search, and the search asks for the hire, not for vacancies.
  const done = or.hiring.kind === 'hire_made'
  const rw = done ? (or.hiring.role ?? '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 2 && !['of', 'the', 'and', 'for', 'an'].includes(w)) : []
  const hiringShown = (l: CorroLead) => done ? quoteShowsCompletedHire(l.excerpt, l.company, rw, !!or.hiring.first) : affirmativeSalesHiring(l.excerpt, l.company)
  const out: CorroTarget[] = [], seen = new Set<string>()
  for (const l of leads) {
    if (out.length >= slots) break
    const key = companyKey(l.company)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (quoteShowsEvent(l.excerpt, l.signal, true, l.company, stage) || hiringShown(l)) continue   // its own quote already shows a branch
    const branch = claimedBranch(l.signal ?? '') ?? claimedBranch(l.excerpt ?? '')   // the extraction names the fact in "signal"
    if (!branch) continue
    const name = l.company.replace(/["\n]/g, ' ').trim()
    out.push({ company: l.company, branch, query: (branch === 'event' ? `"${name}" raised ${stage ? `${stage} ` : ''}funding round` : done ? `"${name}" ${or.hiring.first ? 'first ' : ''}${or.hiring.role || 'sales'} hire hired` : `"${name}" hiring sales`).slice(0, 150) })
  }
  return out
}
