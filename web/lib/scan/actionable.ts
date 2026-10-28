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
import { titleMatches } from '../people/rank.ts'
import { salesHiringRequired } from './sales-hiring-gate.ts'

export const ACTIONABLE_CONNECTOR = 'scan:actionable'
export type Missing = 'no_domain' | 'no_sales_vacancy' | 'no_contact_person' | 'no_published_contact'
// Mailboxes that are not a way to reach a founder: support, privacy, legal, careers, recruiting, press, abuse, no-reply, billing.
export const NOT_A_FOUNDER_ROUTE = /^(?:support|help|privacy|legal|dpo|security|abuse|careers?|jobs?|recruit\w*|hiring|talent|hr|people|press|media|pr|billing|accounts?|invoices?|noreply|no-reply|donotreply|webmaster|postmaster|compliance|gdpr)$/i
const FOUNDER = /\b(?:founder|co-?founder|ceo|chief executive|managing director|owner|president)\b/i

export interface LeadYield { lead_id: string; company: string; actionable: boolean; missing: Missing[]; person: string | null; route: string | null }
export interface YieldSummary { source_checked: number; verified: number; actionable: number; missing: Record<string, number>; leads: { company: string; actionable: boolean; missing: Missing[] }[] }

const whoOf = (icp: string | null | undefined): string => { try { const j = icp ? JSON.parse(icp) as { who?: unknown } : null; return Array.isArray(j?.who) ? j!.who.filter((x): x is string => typeof x === 'string').join(' ') : '' } catch { return '' } }

export function classifyLeads(db: Database.Database, job: { id: string; user_id: string; query?: string | null; icp?: string | null }): LeadYield[] {
  const leads = db.prepare("SELECT id, company, company_domain FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND company <> '' ORDER BY score DESC").all(job.id) as { id: string; company: string; company_domain: string | null }[]
  const needVacancy = salesHiringRequired(job.query, job.icp), who = whoOf(job.icp) || 'founder'
  const enr = db.prepare("SELECT connector, kind, value, source_url FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ?")
  return leads.map(l => {
    const rows = enr.all(l.id, job.user_id) as { connector: string; kind: string; value: string; source_url: string }[]
    const missing: Missing[] = []
    if (!l.company_domain) missing.push('no_domain')
    // The sales-hiring half is enforced by the gate (applySalesHiringGate runs before this): a lead that is still verified has the proof.
    void needVacancy
    const people = rows.filter(r => r.kind === 'person' && r.connector === 'sitecrawl')
    const person = people.find(p => { const t = p.value.split(',').slice(1).join(',').trim(); return FOUNDER.test(t) || titleMatches(t, who).length > 0 })
    if (!person) missing.push('no_contact_person')
    const route = rows.find(r => r.connector === 'sitecrawl' && (r.kind === 'phone' || (r.kind === 'email' && !NOT_A_FOUNDER_ROUTE.test(r.value.split('@')[0].replace(/[._-]/g, '')))))
    if (!route) missing.push('no_published_contact')
    return { lead_id: l.id, company: l.company, actionable: missing.length === 0, missing, person: person?.value ?? null, route: route ? `${route.kind}: ${route.value}` : null }
  })
}

// Writes one enrichment row per verified lead (replacing an earlier call's) and returns the summary for the run report.
export function recordActionability(db: Database.Database, job: { id: string; user_id: string; query?: string | null; icp?: string | null }): YieldSummary {
  const rows = classifyLeads(db, job)
  const del = db.prepare("DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?")
  const missing: Record<string, number> = {}
  for (const r of rows) {
    try {
      del.run(r.lead_id, job.user_id, ACTIONABLE_CONNECTOR)
      addEnrichment(db, job.user_id, r.lead_id, { connector: ACTIONABLE_CONNECTOR, kind: 'actionability', value: r.actionable ? 'Actionable: domain, person and published contact confirmed' : `Not actionable yet: ${r.missing.map(m => m.replace(/_/g, ' ')).join(', ')}`, label: r.actionable ? `${r.person} - ${r.route}`.slice(0, 200) : 'Source-checked only; missing parts stay unknown, nothing is guessed', confidence: null, source_url: 'https://invalid.example/', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
    } catch { /* an old schema never blocks the scan */ }
    for (const m of r.missing) missing[m] = (missing[m] ?? 0) + 1
  }
  const total = (db.prepare("SELECT count(*) AS n FROM leads WHERE scan_job_id = ? AND company <> ''").get(job.id) as { n: number }).n
  return { source_checked: total, verified: rows.length, actionable: rows.filter(r => r.actionable).length, missing, leads: rows.slice(0, 30).map(r => ({ company: r.company, actionable: r.actionable, missing: r.missing })) }
}
