// Supplemental research is not a lead. Finished scan jobs and their results stay unchanged.
import {createHash,randomBytes} from 'node:crypto'
import {asDb,type DbLike,type Tx,type TxBody} from '../db/client.ts'
import {parseSourceReview,type SourceReviewInput} from './source-review.ts'
import {fetchPageDetailed,isFail,type Page,type FetchFail} from './fetch-page.ts'
import {effectiveOffer,tenantOffer} from './play-offer-text.ts'

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
interface Job {id:string;query:string|null;icp:string|null;offer:string|null;seller:string|null;status:string;created_at:number}
function* context(t:Tx,tenant:string,job:string):TxBody<{job:Job|undefined;profile:{sells:string|null}|undefined;memory:{positioning:string|null}|undefined}> {
 const lock=t.kind==='pg'?' FOR UPDATE':''
 const row=yield* t.get<Job>('SELECT id,query,icp,offer,seller,status,created_at FROM scan_jobs WHERE id=? AND user_id=?'+lock,[job,tenant])
 const profile=yield* t.get<{sells:string|null}>('SELECT sells FROM users WHERE id=?'+lock,[tenant])
 const memory=yield* t.get<{positioning:string|null}>('SELECT positioning FROM tenant_memory WHERE tenant_id=?'+lock,[tenant])
 return {job:row,profile,memory}
}
function check(page:Page|FetchFail,quote:string,name:string,now:number,url:string):ResearchCheck {
 const provenance={source_url:url,page_title:isFail(page)?null:page.title,page_hash:isFail(page)?null:createHash('sha256').update(page.text).digest('hex'),published:isFail(page)?null:page.published??null}
 if(isFail(page))return {...provenance,fetch_status:page.fail,quote_match:false,company_named:false,checked_at:now}
 const fold=(s:string)=>s.toLowerCase().replace(/\s+/g,' ').trim()
 return {...provenance,fetch_status:'fetched',quote_match:page.text.includes(quote),company_named:fold(quote).includes(fold(name))&&page.text.includes(quote),checked_at:page.retrievedAt}
}
export async function savePlayResearch(dbLike:DbLike,tenant:string,job:string,raw:unknown,fetcher:(url:string)=>Promise<Page|FetchFail>=(url)=>fetchPageDetailed(url,async()=>null),now=Math.floor(Date.now()/1000)) {
 const db=asDb(dbLike),input=parseResearch(raw),before=await db.tx(t=>context(t,tenant,job),'serializable')
 if(!before.job)throw new PlayResearchError('Play not found.')
 if(before.job.status!=='done'||!before.job.query?.trim())throw new PlayResearchError('Choose a completed play with its original request.')
 const offer=effectiveOffer(before.job,tenantOffer(before.memory?.positioning??'',before.profile?.sells??'')??'')
 if(!offer?.offer||offer.conflict)throw new PlayResearchError('Choose what this play sells before saving research.')
 const fetchSafe=async(url:string)=>fetcher(url).catch(()=>({fail:'error' as const}))
 const source=await fetchSafe(input.source_url),person=input.professional_url?(input.professional_url===input.source_url?source:await fetchSafe(input.professional_url)):null
 const source_check=check(source,input.excerpt,input.company,now,input.source_url),person_check=person?check(person,input.person_excerpt,input.person_name,now,input.professional_url):null
 const fingerprint=createHash('sha256').update(JSON.stringify({input,query:before.job.query,offer:offer.offer})).digest('hex')
 const commit=()=>db.tx(function*(t){
  // PG needs predicate protection for a missing fallback row as well as row locks for existing context.
  if(JSON.stringify(yield* context(t,tenant,job))!==JSON.stringify(before))throw new PlayResearchError('The play context changed. Reload before saving research.')
  const existing=yield* t.get<{id:string}>('SELECT id FROM play_research_sources WHERE tenant_id=? AND job_id=? AND fingerprint=?',[tenant,job,fingerprint])
  if(existing)return existing.id
  const id=randomBytes(12).toString('hex')
  yield* t.run('INSERT INTO play_research_sources(id,tenant_id,job_id,fingerprint,input_json,query_snapshot,offer_snapshot,play_created_at,icp_snapshot,offer_source,source_check,person_check,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,tenant,job,fingerprint,JSON.stringify(input),before.job!.query,offer.offer,before.job!.created_at,before.job!.icp,offer.source,JSON.stringify(source_check),person_check?JSON.stringify(person_check):null,now])
  return id
 },'serializable')
 let id=''
 for(let attempt=0;attempt<3;attempt++){
  try{id=await commit();break}catch(e){
   const code=(e as {code?:string}).code
   if(code!=='40001'&&code!=='40P01')throw e
   if(attempt===2)throw new PlayResearchError('The play is being changed. Reload before saving research.')
  }
 }
 return {id,job_id:job,research_only:true,can_draft:false}
}
export async function playResearchCards(dbLike:DbLike,tenant:string,job:string):Promise<PlayResearchCard[]>{
 const db=asDb(dbLike)
 const rows=await db.all<{id:string;input_json:string;query_snapshot:string;offer_snapshot:string;play_created_at:number;icp_snapshot:string|null;offer_source:string;source_check:string;person_check:string|null;created_at:number}>('SELECT r.* FROM play_research_sources r JOIN scan_jobs j ON j.id=r.job_id AND j.user_id=r.tenant_id WHERE r.tenant_id=? AND r.job_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 100',[tenant,job])
 return rows.map(r=>{const i=JSON.parse(r.input_json) as ResearchInput;return {id:r.id,company:i.company,signal:i.signal,source_url:i.source_url,excerpt:i.excerpt,event_date:i.event_date,email_claim:i.contact,person_name:i.person_name,person_role:i.person_role,professional_url:i.professional_url,person_excerpt:i.person_excerpt,query_snapshot:r.query_snapshot,offer_snapshot:r.offer_snapshot,play_created_at:r.play_created_at,icp_snapshot:r.icp_snapshot,offer_source:r.offer_source,source_check:JSON.parse(r.source_check),person_check:r.person_check?JSON.parse(r.person_check):null,created_at:r.created_at}})
}
