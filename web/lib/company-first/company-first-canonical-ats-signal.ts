// Current protected ATS stage only. This does not issue site identity, assess
// a new lead, read a buyer, or compute a final Ready gate.
import { atsPageText, atsPostingRef, atsRecord, atsRecordUrl } from '../sources/ats-posting.ts'
import { observedSafeGet, type ObservedSafeGet } from '../sources/http.ts'
import type { Page } from '../scan/fetch-page.ts'
import { greenhouseDescriptionFragments } from './company-first-public-reader.ts'
import { verifyEvidence } from '../scan/evidence.ts'
import { readPublicAtsSignal, type PublicAtsPorts } from './company-first-ats-read.ts'
import { isRecentCompanyFirstSignal } from './company-first-signal-freshness.ts'
import type { CompanyFirstPorts, Scope } from './company-first-evidence.ts'

type Stage=CompanyFirstPorts['verifyDatedSignal']
type Request=Parameters<Stage>[0]
type OwnedLink=NonNullable<Awaited<ReturnType<PublicAtsPorts['readCurrentOwnedLink']>>>
export interface CanonicalAtsBinding {
  // Resolve the ORIGINAL verified site/link for this exact protected attempt
  // (the worker's private issuedSites map), and recheck currentness.
  readCurrentOwnedLink(scope:Scope,input:Request['input'],signal:AbortSignal):Promise<OwnedLink|null>
  reserveCurrentPublisherRead(r:Readonly<{scope:Scope;exactUrl:string;reviewVersion:string;signal:AbortSignal}>):Promise<boolean>
  approvedRoleKey:string
  matchesRole:PublicAtsPorts['matchesRole']
  matchesPlace:PublicAtsPorts['matchesPlace']
}
// A non-null closing deadline is actionable only if it is a valid
// timestamp with an explicit offset. Date-only or ambiguous clocks hold.
function stillAccepting(v:unknown, now:number):boolean {
  if(v===undefined||v===null)return true
  if(typeof v!=='string')return false
  const m=/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(v)
  if(!m)return false
  const day=new Date(m[1])
  return Number.isFinite(+day)&&day.toISOString().slice(0,10)===m[1]&&Date.parse(v)>now
}
const mime=/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i

type Lease = Readonly<{scope:Scope;sourceUrl:string;page:Page;expires:number;ownerStillCurrent(signal:AbortSignal):Promise<boolean>}>
const canonicalPages=new WeakMap<object,Lease>()
function sameScope(a:Scope,b:Scope){return a.tenant===b.tenant&&a.job===b.job&&a.attempt===b.attempt}
/** Protected canonical verifier only. Direct HTTPS API bytes already observed
 * in this attempt, never a generic cached page, public result or copied body.
 * Recheck the exact owned posting lease before returning its frozen Page. */
export async function readCanonicalAtsPage(original:object|undefined,scope:Scope,sourceUrl:string,signal:AbortSignal):Promise<Page|null>{
  const lease=original&&canonicalPages.get(original)
  if(!lease||signal.aborted||!sameScope(lease.scope,scope)||lease.sourceUrl!==sourceUrl||Date.now()>=lease.expires)return null
  try {
    return await lease.ownerStillCurrent(signal)&&!signal.aborted&&Date.now()<lease.expires?lease.page:null
  }catch{return null}
}
export function createCanonicalAtsSignal(scope:Scope,binding:CanonicalAtsBinding,wire:ObservedSafeGet=observedSafeGet):Stage{
  const exactScope=Object.freeze({tenant:scope.tenant,job:scope.job,attempt:scope.attempt})
  const roleKey=binding.approvedRoleKey
  return async ({input,signal})=>{
    if(signal.aborted||input.event!=='hiring_posting'||!input.postingUrl||!roleKey)return null
    const request=Object.freeze({...input})
    const postingUrl=input.postingUrl
    const ref=atsPostingRef(postingUrl)
    // Narrow first vertical slice: Greenhouse's record explicitly identifies
    // the employer. Vendor records whose only identity is a slug stay out.
    if(!ref||ref.kind!=='greenhouse')return null
    const api=atsRecordUrl(ref)
    let authority:OwnedLink|undefined, recordBody:unknown, readOnce=false
    const result=await readPublicAtsSignal({enabled:true,signal},
      {scope:exactScope,companyKey:request.companyKey,websiteOrigin:request.websiteOrigin},
      {roleKey,placeKey:request.place,event:'hiring_posting',from:request.from,through:request.through},{
        async readCurrentOwnedLink(_target,abort){
          const link=await binding.readCurrentOwnedLink(exactScope,request,abort)
          if(!link||link.literalPostingHref!==postingUrl)return null
          authority=Object.freeze({...link,scope:Object.freeze({...link.scope})})
          return authority
        },
        authorizeAndReserve:r=>binding.reserveCurrentPublisherRead({scope:exactScope,exactUrl:api,reviewVersion:r.reviewVersion,signal:r.signal}),
        async readPublicJson(r){
          if(readOnce||r.url!==api||r.redirect!=='error'||r.signal.aborted)return null
          readOnce=true
          const p=await wire(api,{signal:r.signal,accept:'application/json',userAgent:'dazl-contact-check/1.0 (+https://dazl.ai)'})
          if(!p||!p.complete||p.status!==200||p.finalUrl!==api||p.truncated||p.location||p.contentEncoding!=='identity'||
            !mime.test(p.contentType??'')||typeof p.body!=='string'||p.body.length>r.maxBytes||Buffer.byteLength(p.body)>r.maxBytes)return null
          try{
            const payload=JSON.parse(p.body)
            if(!payload||typeof payload!=='object'||Array.isArray(payload)||!stillAccepting(payload.application_deadline,Date.now()))return null
            recordBody=payload
          }catch{return null}
          return {status:p.status,finalUrl:p.finalUrl,body:p.body}
        },
        matchesRole:binding.matchesRole,matchesPlace:binding.matchesPlace,
      })
    if(signal.aborted||result.state!=='candidate'||!authority||!isRecentCompanyFirstSignal(result.date))return null
    const rec=atsRecord(recordBody,ref)
    if(!rec||rec==='missing'||!rec.company||rec.posted!==result.date)return null
    const page=atsPageText(rec,rec.html?greenhouseDescriptionFragments(rec.description).join(' | '):rec.description)
    const now=Date.now()
    const verdict=verifyEvidence({
      name:authority.companyName,company:authority.companyName,contact:null,
      signal:rec.title,source_url:result.sourceUrl,score:0,excerpt:result.quote,event_date:result.date,
    },{...page,postedAt:rec.posted,retrievedAt:Math.floor(now/1000)},new Date(now))
    if(!verdict.ok||!stillAccepting((recordBody as {application_deadline?:unknown}).application_deadline,Date.now()))return null
    // The ATS reader, not the scan verifier's unverified date label, supplies
    // the structured first-published proof. All ordinary holds remain later.
    const proved=Object.freeze({companyKey:result.companyKey,place:result.place,event:result.event,date:result.date,
      sourceUrl:result.sourceUrl,quote:result.quote,literalSourceText:result.literalSourceText,dateProof:Object.freeze(result.dateProof)})
    const original=authority
    canonicalPages.set(proved,Object.freeze({scope:exactScope,sourceUrl:result.sourceUrl,
      page:Object.freeze({...page,board:Object.freeze({...page.board}),postedAt:rec.posted,retrievedAt:Math.floor(now/1000)}),
      expires:Math.min(original.expiresAtMs,now+60_000),
      async ownerStillCurrent(abort:AbortSignal) {
        const link=await binding.readCurrentOwnedLink(exactScope,request,abort)
        return !!link&&sameScope(link.scope,exactScope)&&link.version===original.version&&link.expiresAtMs===original.expiresAtMs&&
          link.companyKey===original.companyKey&&link.companyName===original.companyName&&link.websiteOrigin===original.websiteOrigin&&
          link.kind===original.kind&&link.linkSource===original.linkSource&&link.literalPostingHref===original.literalPostingHref&&
          stillAccepting((recordBody as {application_deadline?:unknown}).application_deadline,Date.now())
      }}))
    return proved
  }
}
