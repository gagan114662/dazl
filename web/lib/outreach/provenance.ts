import type Database from 'better-sqlite3'
import { tableExists } from './send-budget.ts'
import { PUBLISHED_EMAIL_RE } from './published-email.ts'
import { eventDayVerified, surfaceStoredIntent, timingUnconfirmedReason, TIMING_REQUESTED } from '../scan/scoreboard.ts'
import { jobWindowDays } from '../scan/window.ts'

export interface OutreachProvenance {
  company: string
  signal: string
  excerpt: string | null
  source_url: string | null
  event_date: string | null
  date_status: string | null
  /** #1176: the event day is proven by the cited source - the rule the lead's own card uses (eventDayVerified), never date_status */
  day_verified: boolean
  /** the card's timing verdict for this lead under its run's own window (app/api/leads/route.ts), so the line reads as the card does */
  timing: 'proof_backed' | 'unconfirmed'
  window_missed: boolean
  contact_origin: 'lead_record' | 'sitecrawl_record' | 'unknown'
  contact_source_url: string | null
}
const email = (s: string | null) => (s ?? '').trim().toLowerCase()
export function publicSourceUrl(raw: string | null): string | null {
  if (!raw) return null
  try { const u = new URL(raw); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? raw : null } catch { return null }
}
// Current linked records, not a snapshot of what was checked when words were
// generated. Never infer ownership, publication, named buyer identity or consent.
export function messageProvenance(db: Database.Database, tenantId: string, leadId: string, recipient: string): OutreachProvenance | null {
  const lead = db.prepare('SELECT l.company,l.signal,l.evidence_excerpt,l.source_url,l.event_date,l.date_status,l.event_date_proof,l.signal_kind,l.intent,l.contact,j.query AS job_query,j.icp AS job_icp,j.run_budget AS job_run_budget FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(leadId,tenantId) as {company:string;signal:string;evidence_excerpt:string|null;source_url:string|null;event_date:string|null;date_status:string|null;event_date_proof:string|null;signal_kind:string|null;intent:number|null;contact:string|null;job_query:string|null;job_icp:string|null;job_run_budget:string|null}|undefined
  if (!lead) return null
  // the same timing options the leads route builds for the card (app/api/leads/route.ts)
  const windowDays = jobWindowDays({ query: lead.job_query, icp: lead.job_icp, run_budget: lead.job_run_budget })
  const timingOpts = { windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(lead.job_query ?? '') }
  const out: OutreachProvenance = {company:lead.company,signal:lead.signal,excerpt:lead.evidence_excerpt,source_url:publicSourceUrl(lead.source_url),event_date:lead.event_date,date_status:lead.date_status,day_verified:eventDayVerified(lead),timing:surfaceStoredIntent(lead,timingOpts).timing,window_missed:timingUnconfirmedReason(lead,timingOpts)==='out_of_window',contact_origin:'unknown',contact_source_url:null}
  if (!PUBLISHED_EMAIL_RE.test(email(recipient))) return out
  if (email(lead.contact) === email(recipient)) {
    out.contact_origin='lead_record'
    // The lead source proves neither where this address was extracted nor its
    // publication today. Old rows have no dedicated contact-origin URL.
  } else if (tableExists(db,'lead_enrichments')) {
    const rows=db.prepare("SELECT value,source_url FROM lead_enrichments WHERE lead_id=? AND tenant_id=? AND connector='sitecrawl' AND kind='email' ORDER BY retrieved_at DESC, id DESC").all(leadId,tenantId) as {value:string;source_url:string|null}[]
    const match=rows.find(r=>email(r.value)===email(recipient))
    if(match){out.contact_origin='sitecrawl_record';out.contact_source_url=publicSourceUrl(match.source_url)}
  }
  return out
}
