// Worldwide means no jurisdiction assertion. This repository is display-only;
// no sender, mailbox verifier, candidate learner, or draft path reads it. Find work email reads a pair only where the same strict
// crawl step also wrote the US sender route for that exact address and page (lib/people/work-email.ts usCompanyFirstCandidates).
import type Database from 'better-sqlite3'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { asDb, type DbLike } from '../db/client.ts'
import { domainRelationship, domainRelationshipDb } from '../signals/domain-basis.ts'

const MAX_AGE_SECONDS=45*86_400
export const COMPANY_FIRST_ROLE_LABEL='Title on the company page: '
export type CompanyFirstPublishedDisplayRow=Readonly<{
  person:string; address:string; source_url:string; role_quote:string; observed_at:number; display_only:true
}>
type Binding=Omit<CompanyFirstPublishedDisplayRow,'display_only'> & {domain:string}
type Stored=Binding & {lead_id:string;run_budget:string|null}

export function migrateCompanyFirstPublishedDisplay(db:Database.Database):void {
 db.exec(`CREATE TABLE IF NOT EXISTS company_first_published_email_display (
   tenant_id TEXT NOT NULL,
   lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
   scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
   attempt INTEGER NOT NULL CHECK (attempt >= 0),
   version INTEGER NOT NULL CHECK (version = 1),
   domain TEXT NOT NULL CHECK (length(domain) <= 253),
   person TEXT NOT NULL CHECK (length(person) <= 120),
   address TEXT NOT NULL CHECK (length(address) <= 254),
   source_url TEXT NOT NULL CHECK (length(source_url) <= 500),
   role_quote TEXT NOT NULL CHECK (length(role_quote) <= 60),
   observed_at INTEGER NOT NULL CHECK (observed_at > 0),
   PRIMARY KEY (tenant_id, lead_id)
 )`)
}
export async function withdrawCompanyFirstPublishedDisplay(d:DbLike,tenantId:string,leadId:string):Promise<void> {
 try{await asDb(d).run('DELETE FROM company_first_published_email_display WHERE tenant_id=? AND lead_id=?',[tenantId,leadId])}
 catch(e){if(!/no such table|relation .* does not exist/i.test(String((e as Error)?.message)))throw e}
}

function valid(r:Binding){
 try{
  const u=new URL(r.source_url)
  return u.protocol==='https:'&&u.href===r.source_url&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&
   u.hostname.replace(/^www\./,'')===r.domain&&r.source_url.length<=500&&
   /^[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.address)&&r.address.length<=254&&
   r.address.split('@')[1].toLowerCase()===r.domain&&r.person.length>0&&r.person.length<=120&&
   r.role_quote.length>0&&r.role_quote.length<=60&&r.person.endsWith(', '+r.role_quote.replace(/\s+/g,' '))&&
   Number.isSafeInteger(r.observed_at)&&r.observed_at>0
 }catch{return false}
}
export async function recordCompanyFirstPublishedDisplay(d:DbLike,tenantId:string,leadId:string,jobId:string,attempt:number,r:Binding):Promise<void>{
 if(!valid(r)||!Number.isSafeInteger(attempt)||attempt<0)return
 const db=asDb(d)
 const job=await db.get<{run_budget:string|null}>(`SELECT j.run_budget FROM scan_jobs j JOIN leads l ON l.scan_job_id=j.id
  WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.status IN ('running','done') AND l.id=? AND l.company_domain=?`,[jobId,tenantId,attempt,leadId,r.domain])
 if(!hasCompanyFirstBudget(job?.run_budget)||await domainRelationshipDb(db,tenantId,leadId,r.domain)!=='established')return
 await db.run(`INSERT INTO company_first_published_email_display
  (tenant_id,lead_id,scan_job_id,attempt,version,domain,person,address,source_url,role_quote,observed_at)
  SELECT ?,?,?,?,1,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM suppressions WHERE tenant_id=? AND email=lower(?))
  ON CONFLICT DO NOTHING`,[tenantId,leadId,jobId,attempt,r.domain,r.person,r.address,r.source_url,r.role_quote,r.observed_at,tenantId,r.address])
}

const DISPLAY_SQL=(n:number)=>`SELECT d.lead_id,d.domain,d.person,d.address,d.source_url,d.role_quote,d.observed_at,j.run_budget
   FROM company_first_published_email_display d JOIN leads l ON l.id=d.lead_id AND l.scan_job_id=d.scan_job_id
   JOIN scan_jobs j ON j.id=d.scan_job_id AND j.user_id=d.tenant_id AND j.attempts=d.attempt
   WHERE d.tenant_id=? AND d.lead_id IN (${Array.from({length:n},()=>'?').join(',')}) AND d.version=1
     AND d.observed_at BETWEEN ? AND ? AND l.company_domain=d.domain AND j.status IN ('running','done')
     AND l.quarantined_at IS NULL AND l.review_reason IS NULL AND l.confidence IS NOT NULL
     AND EXISTS (SELECT 1 FROM lead_enrichments e WHERE e.tenant_id=d.tenant_id AND e.lead_id=d.lead_id
      AND e.connector='sitecrawl' AND e.kind='person' AND e.value=d.person AND e.source_url=d.source_url
      AND e.label=? || d.role_quote AND e.retrieved_at=d.observed_at)
     AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=d.tenant_id AND s.email=lower(d.address))`
const leadParts=(leadIds:readonly string[])=>{
 const ids=[...new Set(leadIds.filter(id=>/^[a-f0-9]{24}$/.test(id)))], parts:string[][]=[]
 for(let i=0;i<ids.length;i+=200)parts.push(ids.slice(i,i+200))
 return parts
}
const shown=(row:Stored):CompanyFirstPublishedDisplayRow=>{
 const {person,address,source_url,role_quote,observed_at}=row
 return Object.freeze({person,address,source_url,role_quote,observed_at,display_only:true})
}
const missingTable=(e:unknown)=>/no such table|relation .* does not exist/i.test(String((e as Error)?.message))

/** Display provenance only. Its present role, exact site, age and ownership bind
 * on every read. Callers still enforce the existing non-send lead view gates. */
export async function companyFirstPublishedDisplayRows(d:DbLike,tenantId:string,leadIds:readonly string[],nowSeconds=Math.floor(Date.now()/1000)):
 Promise<Record<string,CompanyFirstPublishedDisplayRow>>{
 const db=asDb(d)
 const out:Record<string,CompanyFirstPublishedDisplayRow>={}
 if(!Number.isSafeInteger(nowSeconds)||nowSeconds<1)return out
 try{for(const part of leadParts(leadIds)){
  const rows=await db.all<Stored>(DISPLAY_SQL(part.length),[tenantId,...part,nowSeconds-MAX_AGE_SECONDS,nowSeconds,COMPANY_FIRST_ROLE_LABEL])
  for(const row of rows){
   if(!hasCompanyFirstBudget(row.run_budget)||!valid(row)||await domainRelationshipDb(db,tenantId,row.lead_id,row.domain)!=='established')continue
   out[row.lead_id]=shown(row)
  }
 }}catch(e){if(!missingTable(e))throw e}
 return out
}

/** The same rows, with the same binding, for a synchronous SQLite reader (Find work email). */
export function companyFirstPublishedDisplayRowsSync(db:Database.Database,tenantId:string,leadIds:readonly string[],nowSeconds=Math.floor(Date.now()/1000)):
 Record<string,CompanyFirstPublishedDisplayRow>{
 const out:Record<string,CompanyFirstPublishedDisplayRow>={}
 if(!Number.isSafeInteger(nowSeconds)||nowSeconds<1)return out
 try{for(const part of leadParts(leadIds)){
  const rows=db.prepare(DISPLAY_SQL(part.length)).all(tenantId,...part,nowSeconds-MAX_AGE_SECONDS,nowSeconds,COMPANY_FIRST_ROLE_LABEL) as Stored[]
  for(const row of rows){
   if(!hasCompanyFirstBudget(row.run_budget)||!valid(row)||domainRelationship(db,tenantId,row.lead_id,row.domain)!=='established')continue
   out[row.lead_id]=shown(row)
  }
 }}catch(e){if(!missingTable(e))throw e}
 return out
}
