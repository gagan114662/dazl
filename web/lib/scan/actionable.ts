// "Qualified / actionable" yield, measured separately from "source-checked". A lead is ACTIONABLE only when, at the END of enrichment, it has
//   - a company domain the crawl confirmed (the homepage named the company and agreed on the place),
//   - when the request needs sales hiring: the sales-hiring proof (it is still verified after the gate: own quote, dated ATS posting, or a careers-page vacancy),
//   - a named person with a title matching the requested contact role (identity), taken from the company's own pages,
//   - AND a contact route the company itself published on its own domain (a phone, or a role mailbox that is not support / privacy / legal / careers / press ...).
// Person identity and contact evidence are separate facts: a listed founder with no published route, or a mailbox with no named person, is not actionable and
// the lead says which part is missing. Nothing is guessed (no email patterns). Each lead gets one `scan:actionable` enrichment row (shown beside the lead) and
// the run report gets the same counts, so the report and the card agree.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { currentSiteContact, NOT_A_FOUNDER_ROUTE, personMatchesRole, whoOf } from './site-contact.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'
import { FIT_MIN } from './scoreboard.ts'
import { getMemory, isExcluded } from '../memory.ts'
import { requiredGateHeld } from './held-state.ts'
import { compileTargeting, evaluatePlan, type ClauseProof } from './targeting.ts'
import { planProofs } from './targeting-proof.ts'
import { listCompetitors } from '../signals/competitor-reddit.ts'
import { type DemandRubric } from './demand-qualifier.ts'
import { planNeedSupport, revalidateArtifactBinding, revalidateDemandContext, revalidateVerifiedBinding, type NeedRecord } from './need-evidence.ts'
import { domainConfirmed } from '../signals/domain-basis.ts'

const GATES = new Set<string>(['sales_hiring_check_failed', 'quarantined', 'excluded', 'fit_below_threshold', 'not_graded', 'targeting_not_proven'])
export const TARGETING_CONNECTOR = 'scan:targeting'
export const ACTIONABLE_CONNECTOR = 'scan:actionable'
export type Missing = 'sales_hiring_check_failed' | 'targeting_not_proven' | 'buying_need_unproven' | 'quarantined' | 'excluded' | 'fit_below_threshold' | 'not_graded' | 'no_domain' | 'domain_unconfirmed' | 'no_sales_vacancy' | 'no_contact_person' | 'no_published_contact'
// The person / route rule lives in site-contact.ts (one rule for actionability, the timing proof and completion); re-exported for existing callers.
export { NOT_A_FOUNDER_ROUTE, personMatchesRole, whoOf }
// `targeting`: the clause-by-clause proof of the request's compiled plan (#380), present only when the plan says more than one flat signal.
export interface LeadYield { held?: boolean; url?: string; lead_id: string; company: string; actionable: boolean; missing: Missing[]; person: string | null; route: string | null; targeting?: ClauseProof[] }
export interface YieldSummary { held_leads?: { id: string; company: string; url: string }[]; source_checked: number; verified: number; actionable: number; missing: Record<string, number>; leads: { company: string; actionable: boolean; missing: Missing[] }[] }


// `held`: leads a REQUIRED gate failed on, kept in memory by the caller. They are held even when the database still says verified (the recovery write was rejected too).
export type HeldIds = ReadonlyMap<string, string>   // lead id -> reason
// #401/#379: the buying-need promotion gate. `rubric` is the play's CURRENT demand rubric, resolved by the CALLER
// through the canonical ASYNC loader (loadPlayDemandRubric): classifyLeads stays sync and never bypasses a load
// error - a null rubric simply means no demand-post record can verify, so those leads hold. A trigger-only record
// passes this gate (the sales-hiring gate already ran) but never claims verified buying need.
export interface NeedGate { rubric: DemandRubric | null }
// The sync side of the ONE shared revalidation (need-evidence.ts owns the rules; both paths call the same pure
// functions): a recorded verified_buying_need is believed only while every binding holds NOW - qualifier version,
// plan semantics, the current rubric's offer and window, the classifier re-run on the STORED source artifact, the
// source author's own company matching the lead's company, and the domain confirmed now. A missing table (older
// store), a missing or failed writer record, a read error, or any drift is NOT proven. Reads here never write.
type NeedRow = Pick<NeedRecord, 'job_id' | 'basis' | 'verdict' | 'qualifier_version' | 'offer' | 'window_days' | 'plan_support' | 'demand_class' | 'demand_tier' | 'source_url' | 'source_title' | 'source_text' | 'author_name' | 'author_headline' | 'author_company' | 'author_url' | 'published_at' | 'lead_digest'>
export function needProven(db: Database.Database, job: { id: string; user_id: string }, l: { id: string; company: string; company_domain: string | null; source_url: string | null; evidence_excerpt: string | null; published_at: string | null }, ctx: { rubric: DemandRubric | null; planSupportKey: string; asOf: Date }): boolean {
  let rec: NeedRow | undefined
  try {
    rec = db.prepare('SELECT job_id, basis, verdict, qualifier_version, offer, window_days, plan_support, demand_class, demand_tier, source_url, source_title, source_text, author_name, author_headline, author_company, author_url, published_at, lead_digest FROM lead_need_evidence WHERE tenant_id = ? AND lead_id = ?').get(job.user_id, l.id) as NeedRow | undefined
  } catch { return false }  // an older store without the evidence table: hold, never a bypass
  if (!rec) return false    // the writer failed or never ran for this lead: hold
  // The SAME parity the async reader enforces, BEFORE any verdict bypass: the record belongs to THIS job and the
  // plan semantics have not changed since the writer ran. A stale-plan or misbound-job record can never promote.
  if (rec.job_id !== job.id) return false
  if (rec.plan_support !== ctx.planSupportKey) return false
  if (rec.verdict === 'trigger_only') return true // the trigger gate already ran; trigger-only is never "verified buying need"
  if (rec.verdict !== 'verified_buying_need' || rec.basis !== 'demand_post') return false
  if (!revalidateDemandContext(rec, { rubric: ctx.rubric, rubricReason: null, planSupportKey: ctx.planSupportKey, asOf: ctx.asOf }).ok) return false
  // The SAME artifact binding as the async reader: the lead's current citation/quote/date are the recorded ones.
  if (!revalidateArtifactBinding(rec, l).ok) return false
  return revalidateVerifiedBinding(rec, l.company, l.company_domain, domainConfirmed(db, job.user_id, l.id, l.company_domain)).ok
}

export function classifyLeads(db: Database.Database, job: { id: string; user_id: string; query?: string | null; icp?: string | null }, held: HeldIds = new Map(), need: NeedGate = { rubric: null }): LeadYield[] {
  const leads = db.prepare("SELECT id, company, company_domain, contact, fit, quarantined_at, source_url, evidence_excerpt, published_at, signal, event_date FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND company <> '' ORDER BY score DESC").all(job.id) as { id: string; company: string; company_domain: string | null; contact: string | null; fit: number | null; quarantined_at: number | null; source_url: string; evidence_excerpt: string | null; published_at: string | null; signal: string | null; event_date: string | null }[]
  let memory: ReturnType<typeof getMemory> | null = null
  try { memory = getMemory(db, job.user_id) } catch { memory = null } // the table may predate this deploy
  const needVacancy = salesHiringRequired(job.query, job.icp), who = whoOf(job.icp) || 'founder'
  // #380: an explicit plan (two or more conditions, a NOT, an exclusion, a completed hire or separate clocks) is a REQUIRED gate on top of the
  // others: only a plan that evaluates to 'pass' on verified facts qualifies the lead. Unknown holds it. A single flat signal stays with the gates above.
  const plan = compileTargeting(job.query, job.icp)
  const supportKey = JSON.stringify(planNeedSupport(plan))
  const planGated = plan.explicit && plan.root !== null
  let competitors: string[] | null = null
  if (planGated) { try { competitors = listCompetitors(db, job.user_id) } catch { competitors = null } } // no table: no list, so a competitor exclusion stays unknown
  const enr = db.prepare("SELECT connector, kind, value, label, source_url, source_date FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ?")
  return leads.map(l => {
    const rows = enr.all(l.id, job.user_id) as { connector: string; kind: string; value: string; label: string | null; source_url: string; source_date: string }[]
    const missing: Missing[] = []
    let targeting: ClauseProof[] | undefined
    // Buyer gates first: a quarantined, excluded or low-fit lead is not actionable whatever domain or contact fields it has.
    const gateHeld = held.has(l.id) || requiredGateHeld(db, job.user_id, l.id) !== null   // the SAME check the draft guard uses: a lead whose pass record could not be saved is held here too
    const gate: Missing | null = gateHeld ? 'sales_hiring_check_failed' : l.quarantined_at != null ? 'quarantined' : isExcluded(memory, l) ? 'excluded' : l.fit == null ? 'not_graded' : l.fit < FIT_MIN ? 'fit_below_threshold' : null
    if (gate) return { lead_id: l.id, company: l.company, actionable: false, missing: [gate], person: null, route: null, held: gate === 'sales_hiring_check_failed', url: l.source_url }
    if (planGated) {
      const ev = evaluatePlan(plan, planProofs(plan, l, rows.filter(r => r.connector !== TARGETING_CONNECTOR && r.connector !== ACTIONABLE_CONNECTOR), { query: job.query, icp: job.icp, salesGatePassed: salesHiringRequired(job.query, job.icp), competitors, graded: true }))
      if (ev.truth !== 'pass') return { lead_id: l.id, company: l.company, actionable: false, missing: ['targeting_not_proven'], person: null, route: null, targeting: ev.clauses }
      targeting = ev.clauses
    }
    // #401/#379: no proven buying need, no promotion - collected with the other current gaps so the lead says
    // everything that is missing, while the company, person and route below stay OUTER requirements, never substitutes.
    if (!needProven(db, job, l, { rubric: need.rubric, planSupportKey: supportKey, asOf: new Date() })) missing.push('buying_need_unproven')
    // The sales-hiring half is enforced by the gate (applySalesHiringGate runs before this): a lead that is still verified has the proof.
    void needVacancy
    // Domain, person and route are read from the CURRENT rows through the shared rule (#914): a confirmed domain, and a person / route
    // whose source is that domain. A contact-source pass that failed or was skipped cannot leave a foreign contact counted here.
    const site = currentSiteContact(db, job.user_id, l, who, rows)
    if (!l.company_domain) missing.push('no_domain')
    else if (!site.confirmed) missing.push('domain_unconfirmed')
    const person = site.person
    if (!person) missing.push('no_contact_person')
    const route = site.route
    if (!route) missing.push('no_published_contact')
    return { lead_id: l.id, company: l.company, actionable: missing.length === 0, missing, person: person?.value ?? null, route: route ? `${route.kind}: ${route.value}` : null, ...(targeting ? { targeting } : {}) }
  })
}

// Writes one enrichment row per verified lead (replacing an earlier call's) and returns the summary for the run report.
export function recordActionability(db: Database.Database, job: { id: string; user_id: string; query?: string | null; icp?: string | null }, held: HeldIds = new Map(), need: NeedGate = { rubric: null }): YieldSummary {
  const rows = classifyLeads(db, job, held, need)
  const del = db.prepare("DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?")
  const missing: Record<string, number> = {}
  for (const r of rows) {
    try {
      del.run(r.lead_id, job.user_id, ACTIONABLE_CONNECTOR)
      del.run(r.lead_id, job.user_id, TARGETING_CONNECTOR)
      // One row per clause: the condition, its truth and why (the source it was proven on, or what is missing).
      for (const c of r.targeting ?? []) addEnrichment(db, job.user_id, r.lead_id, { connector: TARGETING_CONNECTOR, kind: 'targeting_clause', value: `${c.id} ${c.negated ? 'NOT ' : ''}${c.text}: ${c.truth}`.slice(0, 254), label: c.reason.slice(0, 200), confidence: null, source_url: c.source_url && /^https?:/.test(c.source_url) ? c.source_url.slice(0, 500) : 'https://invalid.example/', source_date: c.date ?? new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
      addEnrichment(db, job.user_id, r.lead_id, { connector: ACTIONABLE_CONNECTOR, kind: 'actionability', value: r.actionable ? 'Actionable: domain, person and published contact confirmed' : `Not actionable yet: ${r.missing.map(m => m.replace(/_/g, ' ')).join(', ')}`, label: r.actionable ? `${r.person} - ${r.route}`.slice(0, 200) : GATES.has(r.missing[0]) ? 'Not a qualified buyer: a found domain or contact does not change that' : 'Source-checked only; missing parts stay unknown, nothing is guessed', confidence: null, source_url: 'https://invalid.example/', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
    } catch { /* an old schema never blocks the scan */ }
    for (const m of r.missing) missing[m] = (missing[m] ?? 0) + 1
  }
  const total = (db.prepare("SELECT count(*) AS n FROM leads WHERE scan_job_id = ? AND company <> ''").get(job.id) as { n: number }).n
  return { source_checked: total, verified: rows.filter(r => !r.held).length, held_leads: rows.filter(r => r.held).map(r => ({ id: r.lead_id, company: r.company, url: r.url ?? '' })), actionable: rows.filter(r => r.actionable).length, missing, leads: rows.slice(0, 30).map(r => ({ company: r.company, actionable: r.actionable, missing: r.missing })) }
}
