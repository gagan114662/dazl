import {contactContext} from '../outreach/contact-context.ts'
import {randomBytes} from 'node:crypto'
import type Database from 'better-sqlite3'
import {fetchPageDetailed,isFail,type Page,type FetchFail} from './fetch-page.ts'
import {companyKey,hasPhrase,norm} from './evidence.ts'
import {PUBLISHED_EMAIL_RE} from '../outreach/published-email.ts'

export interface SourceReviewInput {company:string;signal:string;source_url:string;excerpt:string;contact:string|null;event_date:string|null}
export class SourceReviewError extends Error {}
export function parseSourceReview(raw:unknown):SourceReviewInput {
 if(!raw || typeof raw!=='object' || Array.isArray(raw))throw new SourceReviewError('Add a company, signal, source URL and exact quote.')
 const r=raw as Record<string,unknown>
 const text=(key:string,max:number,min=1)=>{const v=r[key];if(typeof v!=='string'||v.length<min||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)||!v.trim())throw new SourceReviewError(`Check ${key} (${min}-${max} characters).`);return v}
 const company=text('company',150),signal=text('signal',500),source_url=text('source_url',500),excerpt=text('excerpt',400,20)
 try{const u=new URL(source_url);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw new Error()}catch{throw new SourceReviewError('Use a public HTTPS source URL without login details.')}
 const contact=r.contact===null||r.contact===''||r.contact===undefined?null:text('contact',254)
 if(contact&&!PUBLISHED_EMAIL_RE.test(contact.trim()))throw new SourceReviewError('Use an email address from the source, or leave it empty.')
 const event_date=r.event_date===null||r.event_date===''||r.event_date===undefined?null:text('event_date',10,10)
 if(event_date){const d=new Date(`${event_date}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(event_date)||Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==event_date)throw new SourceReviewError('Use a real YYYY-MM-DD event date, or leave it empty.')}
 return {company,signal,source_url,excerpt,contact,event_date}
}
export function migrateSourceReview(db:Database.Database):void {
 db.exec(`CREATE TABLE IF NOT EXISTS source_reviews (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, lead_id TEXT NOT NULL,
 input_json TEXT NOT NULL, fetch_status TEXT NOT NULL, quote_match INTEGER NOT NULL,
 company_named INTEGER NOT NULL, contact_match INTEGER NOT NULL, checked_at INTEGER NOT NULL
 ); CREATE INDEX IF NOT EXISTS source_reviews_tenant ON source_reviews(tenant_id,lead_id)`)
}
export interface SourceCheck {fetch_status:string;quote_match:boolean;company_named:boolean;contact_match:boolean;checked_at:number}
// This path has no model, discovery, enrichment, renderer fallback or send. It
// records literal source checks only. The supplied signal/date remain claims.
export async function createSourceReview(db:Database.Database,tenant:string,input:SourceReviewInput,fetcher:(url:string)=>Promise<Page|FetchFail>=(url)=>fetchPageDetailed(url,async()=>null),now=Math.floor(Date.now()/1000)) {
 input=parseSourceReview(input)
 const page=await fetcher(input.source_url).catch(()=>({fail:'error' as const}))
 const ok=!isFail(page)
 const key=companyKey(input.company)
 const quoteMatch=ok&&page.text.includes(input.excerpt)
 const emailMatch=ok&&!!input.contact&&page.text.toLowerCase().split(/[^a-z0-9@._%+\-]+/).includes(input.contact.trim().toLowerCase())
 const check:SourceCheck={fetch_status:ok?'fetched':page.fail,quote_match:quoteMatch,company_named:quoteMatch&&ok&&key.length>=2&&(hasPhrase(norm(input.excerpt),key)||hasPhrase(norm(page.title),key)),contact_match:emailMatch,checked_at:ok?page.retrievedAt:now}
 const jobId=randomBytes(12).toString('hex'),leadId=randomBytes(12).toString('hex'),id=randomBytes(12).toString('hex')
 db.transaction(()=>{
 db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status) VALUES(?,?,'Source review intake','manual','manual','running')").run(jobId,tenant)
 // Never promote these literal checks to semantic verification or human consent.
 db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,evidence_excerpt,contact,event_date,date_status,retrieved_at,confidence,review_reason,source_kind) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'source_review_required','manual_source')").run(leadId,jobId,input.company,input.signal,input.source_url,input.excerpt,check.contact_match?input.contact:null,input.event_date,input.event_date?'unverified':'undated',ok?page.retrievedAt:null)
 db.prepare('INSERT INTO source_reviews(id,tenant_id,job_id,lead_id,input_json,fetch_status,quote_match,company_named,contact_match,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,tenant,jobId,leadId,JSON.stringify({...input,contact_context:ok&&input.contact?contactContext(page.text,input.contact,input.source_url):null}),check.fetch_status,+check.quote_match,+check.company_named,+check.contact_match,check.checked_at)
 db.prepare("UPDATE scan_jobs SET status='done',finished_at=?,candidates=1,verified=0,needs_review=1,dropped=0 WHERE id=?").run(now,jobId)
 })()
 return {job_id:jobId,lead_id:leadId,check}
}
export function sourceCheckForLead(db:Database.Database,tenant:string,lead:string):SourceCheck|null{
 const r=db.prepare('SELECT r.fetch_status,r.quote_match,r.company_named,r.contact_match,r.checked_at FROM source_reviews r JOIN leads l ON l.id=r.lead_id JOIN scan_jobs j ON j.id=l.scan_job_id AND j.id=r.job_id WHERE r.tenant_id=? AND r.lead_id=? AND j.user_id=?').get(tenant,lead,tenant) as {fetch_status:string;quote_match:number;company_named:number;contact_match:number;checked_at:number}|undefined
 return r?{...r,quote_match:!!r.quote_match,company_named:!!r.company_named,contact_match:!!r.contact_match}:null
}
