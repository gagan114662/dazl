import type Database from 'better-sqlite3'
import {classifyPurpose} from './published-email.ts'
import {readContextLabel,type ContactContext} from './contact-context.ts'
import {tableExists} from './send-budget.ts'
export function leadContactContext(db:Database.Database,tenant:string,lead:string):ContactContext|null {
 if(!tableExists(db,'source_reviews'))return null
 const r=db.prepare('SELECT r.input_json FROM source_reviews r JOIN leads l ON l.id=r.lead_id JOIN scan_jobs j ON j.id=l.scan_job_id AND j.id=r.job_id WHERE r.tenant_id=? AND r.lead_id=? AND j.user_id=? ORDER BY r.checked_at DESC LIMIT 1').get(tenant,lead,tenant) as {input_json:string}|undefined
 try {const c=JSON.parse(r?.input_json??'{}').contact_context;return c&&typeof c.excerpt==='string'&&typeof c.source_url==='string'?c:null}catch{return null}
}
export function contactPurposeRestricted(db:Database.Database,tenant:string,lead:string,email:string):boolean {
 const l=db.prepare('SELECT l.contact,l.source_url,l.evidence_excerpt FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?').get(lead,tenant) as {contact:string|null;source_url:string;evidence_excerpt:string|null}|undefined
 if(!l)return false
 if(classifyPurpose(email).purpose==='non-sales')return true
 if(l.contact?.trim().toLowerCase()===email.trim().toLowerCase() && classifyPurpose(email,leadContactContext(db,tenant,lead)??{excerpt:l.evidence_excerpt??'',source_url:l.source_url}).purpose==='non-sales')return true
 if(tableExists(db,'lead_enrichments')){
 const rows=db.prepare("SELECT value,label,source_url FROM lead_enrichments WHERE tenant_id=? AND lead_id=? AND connector='sitecrawl' AND kind='email'").all(tenant,lead) as {value:string;label:string|null;source_url:string|null}[]
 if(rows.some(r=>r.value.trim().toLowerCase()===email.trim().toLowerCase()&&classifyPurpose(email,readContextLabel(r.label,r.source_url??'')).purpose==='non-sales'))return true
 }
 return false
}
