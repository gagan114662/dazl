// The other half of "seed funding AND hiring sales". A candidate that came from a public job board proves the HIRING half (a dated sales / GTM posting) but its quote is a job ad, which
// never shows a funding round - the sales-hiring gate rightly holds it as no_event_evidence. A funding-news candidate has the reverse gap and is checked against the boards by the gate.
// This closes the first gap WITHOUT a new kind of proof: for the few companies in that position it only decides what to SEARCH for; whatever the news search returns goes through the same
// extraction and the same verifier (quote on the page, identity, date window) as every other candidate, and the gate then merges the verified funding quote with the posting.
import { quoteShowsEvent, requestAsksFunding, requestedStage, salesHiringRequired } from './sales-hiring-gate.ts'
import { companyKey } from './evidence.ts'

export const MAX_CORROBORATE = 3
export interface CorroTarget { company: string; query: string }
export function corroborationTargets(job: { query?: string | null; icp?: string | null }, leads: { company: string; excerpt: string; signal: string }[]): CorroTarget[] {
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
  return out
}
