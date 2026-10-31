// One free, read-only check of the original saved source. Never promotes a lead or calls a model/search.
import {asDb,type DbLike} from '../db/client.ts'
import {fetchPageDetailed,isFail,type Page,type FetchFail} from './fetch-page.ts'
import {readPlayOffer} from './play-offer.ts'
import {parseIcp} from './icp.ts'
import {parseWindowDays,windowStatus} from './window.ts'
import {ownPlaceAgreement} from './own-block.ts'
import {closedJobEvidence} from './closed-job.ts'
import {verifyEvidence,type Candidate} from './evidence.ts'
import {eventDateBound} from './event-date-binding.ts'
import {counterpartySignal} from './counterparty.ts'
interface Saved {id:string;scan_job_id:string;company:string;name:string;signal:string;source_url:string;evidence_excerpt:string|null;event_date:string|null;query:string|null;icp:string|null;review_reason:string|null;company_domain:string|null;contact:string|null;human_confirmed_at:number|null}
export async function evidenceRecheck(db:DbLike,tenant:string,id:string,fetcher:(url:string)=>Promise<Page|FetchFail>=(url)=>fetchPageDetailed(url,async()=>null),now=new Date()){
 const d=asDb(db)
 const read=()=>d.get<Saved>(`SELECT l.id,l.scan_job_id,l.company,l.name,l.signal,l.source_url,l.evidence_excerpt,l.event_date,l.review_reason,l.company_domain,l.contact,l.human_confirmed_at,j.query,j.icp FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id WHERE l.id=? AND j.user_id=?`,[id,tenant])
 const lead=await read();if(!lead)return null
 const offer=await readPlayOffer(db,tenant,lead.scan_job_id)
 const base={lead_id:id,job_id:lead.scan_job_id,company:lead.company,source_url:lead.source_url,checked_at:Math.floor(now.getTime()/1000),offer:offer?.offer??null,query:lead.query,model_call:false,search_call:false,eligibility_changed:false,can_draft:false}
 const blocked=(reason:string)=>({...base,status:'not_checked' as const,reasons:[reason],checks:null})
 if(!offer||offer.conflict||!offer.offer)return blocked('Resolve what this play sells before rechecking its evidence.')
 const icp=lead.icp?parseIcp(lead.icp):null
 if(!icp)return blocked('The saved reviewed targeting is unavailable. No geography or time window was guessed.')
 const page=await fetcher(lead.source_url).catch(()=>({fail:'error' as const}))
 if(JSON.stringify(await read())!==JSON.stringify(lead)||JSON.stringify(await readPlayOffer(db,tenant,lead.scan_job_id))!==JSON.stringify(offer))return blocked('The saved lead or play context changed during the check. Reload before checking again.')
 if(isFail(page))return {...base,status:'unreadable' as const,reasons:[`The saved source could not be read (${page.fail}). Its evidence is unknown.`],checks:null}
 const candidate:Candidate={name:lead.name??'',company:lead.company,signal:lead.signal,source_url:lead.source_url,excerpt:lead.evidence_excerpt??'',event_date:lead.event_date,contact:null,score:0}
 const closed=closedJobEvidence(candidate,page),place=ownPlaceAgreement(page,icp.where,lead.company,candidate.excerpt),literal=verifyEvidence(candidate,page,now)
 const date=lead.event_date?eventDateBound(lead.event_date,page.text,candidate.excerpt,lead.company):null
 const window=windowStatus(date?.bound?lead.event_date:null,parseWindowDays(lead.query??'')??icp.window_days,now)
 const counterparty=counterpartySignal(candidate,page,literal.ok?literal.passage:'')
 const reasons:string[]=[]
 if(closed)reasons.push(`The saved job source says "${closed.marker}". This is historical hiring evidence, not an active opening.`)
 if(place==='mismatch')reasons.push('This company is tied to a different place than the saved play targeting.')
 if(place==='unconfirmed')reasons.push('The saved source does not confirm this company in the requested place.')
 if(!literal.ok)reasons.push(`The saved evidence did not pass the source check (${literal.reason}).`)
 if(lead.event_date&&!date?.bound)reasons.push('The saved event date is not tied to this company and event by this page.')
 if(window!=='inside')reasons.push(`The event is outside the actionable time window (${window}).`)
 if(counterparty)reasons.push('This page describes someone else\'s customer relationship, not this company\'s own signal.')
 reasons.push('This only rechecks the saved source. It does not verify identity, contact, fit, buying need or consent, find new leads, or make this lead ready to draft. The saved review hold is unchanged.')
 return {...base,status:'checked' as const,reasons,checks:{closed_job:closed,place,quote:literal.ok?'matched':literal.reason,event_date_bound:date?.bound??false,window,counterparty:!!counterparty},source_checked_at:page.retrievedAt}
}
