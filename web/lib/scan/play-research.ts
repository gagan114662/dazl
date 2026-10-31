// Supplemental research is not a lead. Finished scan jobs and their results stay unchanged.
import {createHash,randomBytes} from 'node:crypto'
import type Database from 'better-sqlite3'
import {parseSourceReview,type SourceReviewInput} from './source-review.ts'
import {fetchPageDetailed,isFail,type Page,type FetchFail} from './fetch-page.ts'
import {readPlayOffer} from './play-offer.ts'

export class PlayResearchError extends Error {}
export interface ResearchInput extends SourceReviewInput {person_name:string;person_role:string;professional_url:string;person_excerpt:string}
export interface ResearchCheck {fetch_status:string;quote_match:boolean;company_named:boolean;checked_at:number;source_url:string;page_title:string|null;page_hash:string|null;published:string|null}
export interface PlayResearchCard {id:string;company:string;signal:string;source_url:string;excerpt:string;event_date:string|null;email_claim:string|null;person_name:string;person_role:string;professional_url:string;person_excerpt:string;query_snapshot:string;offer_snapshot:string;play_created_at:number;icp_snapshot:string|null;offer_source:string;source_check:ResearchCheck;person_check:ResearchCheck|null;created_at:number}
export function parseResearch(raw:unknown):ResearchInput {
 const base=parseSourceReview(raw),r=raw as Record<string,unknown>
 const field=(key:string,max:number)=>{const v=r[key]??'';if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))throw new PlayResearchError(`Check ${key}.`);return v.trim()}
 const person_name=field('person_name',150),person_role=field('person_role',150),professional_url=field('professional_url',500),person_excerpt=field('person_excerpt',400)
 if([person_name,person_role,professional_url,person_excerpt].some(Boolean)){
  if(!person_name||!person_role||person_excerpt.length<20)throw new PlayResearchError('Include the person name, role, professional source URL and exact quote together.')
  try {const u=new URL(professional_url);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error()}catch{throw new PlayResearchError('Use a public HTTPS professional source URL.')}
 }
 return {...base,person_name,person_role,professional_url,person_excerpt}
}
export const PLAY_RESEARCH_SCHEMA=`CREATE TABLE IF NOT EXISTS play_research_sources (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 input_json TEXT NOT NULL, query_snapshot TEXT NOT NULL, offer_snapshot TEXT NOT NULL,
 play_created_at INTEGER NOT NULL, icp_snapshot TEXT, offer_source TEXT NOT NULL,
 source_check TEXT NOT NULL, person_check TEXT, created_at INTEGER NOT NULL,
 UNIQUE(tenant_id,job_id,fingerprint)
); CREATE INDEX IF NOT EXISTS play_research_sources_play ON play_research_sources(tenant_id,job_id,created_at);`
export function migratePlayResearch(db:Database.Database){db.exec(PLAY_RESEARCH_SCHEMA)}
const jobRow=(db:Database.Database,tenant:string,job:string)=>db.prepare('SELECT id,query,icp,offer,seller,status,created_at FROM scan_jobs WHERE id=? AND user_id=?').get(job,tenant) as {id:string;query:string|null;icp:string|null;offer:string|null;seller:string|null;status:string;created_at:number}|undefined
// Capture fallback inputs too: an offer change during a source fetch must not silently select another seller.
const context=(db:Database.Database,tenant:string,job:string)=>({job:jobRow(db,tenant,job),profile:db.prepare('SELECT sells FROM users WHERE id=?').get(tenant),memory:db.prepare('SELECT positioning FROM tenant_memory WHERE tenant_id=?').get(tenant)})
function check(page:Page|FetchFail,quote:string,name:string,now:number,url:string):ResearchCheck {
 const provenance={source_url:url,page_title:isFail(page)?null:page.title,page_hash:isFail(page)?null:createHash('sha256').update(page.text).digest('hex'),published:isFail(page)?null:page.published??null}
 if(isFail(page))return {...provenance,fetch_status:page.fail,quote_match:false,company_named:false,checked_at:now}
 const fold=(s:string)=>s.toLowerCase().replace(/\s+/g,' ').trim()
 return {...provenance,fetch_status:'fetched',quote_match:page.text.includes(quote),company_named:fold(quote).includes(fold(name))&&page.text.includes(quote),checked_at:page.retrievedAt}
}
export async function savePlayResearch(db:Database.Database,tenant:string,job:string,raw:unknown,fetcher:(url:string)=>Promise<Page|FetchFail>=(url)=>fetchPageDetailed(url,async()=>null),now=Math.floor(Date.now()/1000)) {
 const input=parseResearch(raw),before=context(db,tenant,job)
 if(!before.job)throw new PlayResearchError('Play not found.')
 if(before.job.status!=='done'||!before.job.query?.trim())throw new PlayResearchError('Choose a completed play with its original request.')
 const offer=await readPlayOffer(db,tenant,job)
 if(!offer?.offer||offer.conflict)throw new PlayResearchError('Choose what this play sells before saving research.')
 const fetchSafe=async(url:string)=>fetcher(url).catch(()=>({fail:'error' as const}))
 const source=await fetchSafe(input.source_url),person=input.professional_url?(input.professional_url===input.source_url?source:await fetchSafe(input.professional_url)):null
 const source_check=check(source,input.excerpt,input.company,now,input.source_url),person_check=person?check(person,input.person_excerpt,input.person_name,now,input.professional_url):null
 const fingerprint=createHash('sha256').update(JSON.stringify({input,query:before.job.query,offer:offer.offer})).digest('hex')
 const latest=await readPlayOffer(db,tenant,job)
 if(JSON.stringify(latest)!==JSON.stringify(offer))throw new PlayResearchError('The play context changed. Reload before saving research.')
 const id=db.transaction(()=>{
  if(JSON.stringify(context(db,tenant,job))!==JSON.stringify(before))throw new PlayResearchError('The play context changed. Reload before saving research.')
  const existing=db.prepare('SELECT id FROM play_research_sources WHERE tenant_id=? AND job_id=? AND fingerprint=?').get(tenant,job,fingerprint) as {id:string}|undefined
  if(existing)return existing.id
  const id=randomBytes(12).toString('hex')
  db.prepare('INSERT INTO play_research_sources(id,tenant_id,job_id,fingerprint,input_json,query_snapshot,offer_snapshot,play_created_at,icp_snapshot,offer_source,source_check,person_check,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,tenant,job,fingerprint,JSON.stringify(input),before.job!.query,offer.offer,before.job!.created_at,before.job!.icp,offer.source,JSON.stringify(source_check),person_check?JSON.stringify(person_check):null,now)
  return id
 })()
 return {id,job_id:job,research_only:true,can_draft:false}
}
export function playResearchCards(db:Database.Database,tenant:string,job:string):PlayResearchCard[]{
 if(!jobRow(db,tenant,job))return []
 const rows=db.prepare('SELECT r.* FROM play_research_sources r JOIN scan_jobs j ON j.id=r.job_id AND j.user_id=r.tenant_id WHERE r.tenant_id=? AND r.job_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 100').all(tenant,job) as {id:string;input_json:string;query_snapshot:string;offer_snapshot:string;play_created_at:number;icp_snapshot:string|null;offer_source:string;source_check:string;person_check:string|null;created_at:number}[]
 return rows.map(r=>{const i=JSON.parse(r.input_json) as ResearchInput;return {id:r.id,company:i.company,signal:i.signal,source_url:i.source_url,excerpt:i.excerpt,event_date:i.event_date,email_claim:i.contact,person_name:i.person_name,person_role:i.person_role,professional_url:i.professional_url,person_excerpt:i.person_excerpt,query_snapshot:r.query_snapshot,offer_snapshot:r.offer_snapshot,play_created_at:r.play_created_at,icp_snapshot:r.icp_snapshot,offer_source:r.offer_source,source_check:JSON.parse(r.source_check),person_check:r.person_check?JSON.parse(r.person_check):null,created_at:r.created_at}})
}
