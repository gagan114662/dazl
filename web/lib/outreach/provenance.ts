import type Database from 'better-sqlite3'
import { tableExists } from './send-budget.ts'
import { PUBLISHED_EMAIL_RE } from './published-email.ts'

export interface OutreachProvenance {
  company: string
  signal: string
  excerpt: string | null
  source_url: string | null
  event_date: string | null
  date_status: string | null
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
  const lead = db.prepare('SELECT l.company,l.signal,l.evidence_excerpt,l.source_url,l.event_date,l.date_status,l.contact FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(leadId,tenantId) as {company:string;signal:string;evidence_excerpt:string|null;source_url:string|null;event_date:string|null;date_status:string|null;contact:string|null}|undefined
  if (!lead) return null
  const out: OutreachProvenance = {company:lead.company,signal:lead.signal,excerpt:lead.evidence_excerpt,source_url:publicSourceUrl(lead.source_url),event_date:lead.event_date,date_status:lead.date_status,contact_origin:'unknown',contact_source_url:null}
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
