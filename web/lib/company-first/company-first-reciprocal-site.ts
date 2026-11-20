// Unmounted narrow website authority for a reciprocal public posting link.
// This is not location, buying signal, buyer, email or Ready proof.
import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { getDomain } from 'tldts'
import { ownSiteHost, parseRobots } from '../connectors/sitecrawl.ts'
import { htmlToText } from '../scan/fetch-page.ts'
import type { PublicAtsPorts } from './company-first-ats-read.ts'
import { atsPostingRef, atsRecord, atsRecordUrl } from '../sources/ats-posting.ts'
import { observedSafeGet, type ObservedHttpResult, type ObservedSafeGet } from '../sources/http.ts'
import type { Candidate, Scope } from './company-first-evidence.ts'
import { isCurrentCompanyFirstDeadline } from './company-first-signal-freshness.ts'
import { verifyCompanyWebsite, type WebsiteProof } from './company-first-website-proof.ts'

type Binding = Readonly<{ scope:Scope; candidateName:string; exactPostingUrl:string; settledCallId:string; expiresAtMs:number }>
export interface ReciprocalSiteAuthority {
  // Only the trusted native scope's already settled candidate, not an
  // arbitrary caller-provided citation, can admit this check.
  readCurrentNativePosting(scope:Scope,candidate:Candidate,signal:AbortSignal):Promise<Binding|null>
  reserveCurrentRead(r:Readonly<{scope:Scope;settledCallId:string;exactUrl:string;step:'publisher'|'robots'|'homepage';signal:AbortSignal}>):Promise<boolean>
}
type VerifiedReciprocal=Extract<WebsiteProof,{state:'verified'}>['site']
type OwnedPosting=NonNullable<Awaited<ReturnType<PublicAtsPorts['readCurrentOwnedLink']>>>
const issued=new WeakMap<VerifiedReciprocal, OwnedPosting>()
export function readReciprocalOwnedPosting(site:VerifiedReciprocal,scope:Scope):OwnedPosting|null{
  const r=issued.get(site)
  return r&&eq(r.scope,scope)&&r.expiresAtMs>Date.now()?r:null
}
type OwnedPermalink=Readonly<{url:string;title:string;day:string;deadline:string|null}>
const permalinks=new WeakMap<VerifiedReciprocal,OwnedPermalink>()
export function readReciprocalOwnedCareerPermalink(site:VerifiedReciprocal,scope:Scope):OwnedPermalink|null {
    const link=permalinks.get(site)
  return link&&readReciprocalOwnedPosting(site,scope)&&isCurrentCompanyFirstDeadline(link.deadline,Date.now())?link:null
}
const HELD={state:'held',reason:'identity_unknown'} as const
const UA='dazl-contact-check/1.0 (+https://dazl.ai)'
const MAX_BYTES=128_000
const short=(s:unknown,n=200):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=n&&!/[\p{C}]/u.test(s)
const nfc=(s:string)=>s.normalize('NFC').trim().replace(/\s+/g,' ')
const eq=(a:Scope,b:Scope)=>a?.tenant===b.tenant&&a?.job===b.job&&a?.attempt===b.attempt
function publicUrl(raw:unknown, allowedJobId?:string):URL|null{
  if(!short(raw,480)||/[\s\\#]|%/u.test(raw))return null
  try {
    const u=new URL(raw)
    return (!u.search||(allowedJobId!==undefined&&u.search==='?gh_jid='+allowedJobId))&&u.href===raw&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)&&
      !/\.(?:localhost|local|internal|onion|test|invalid)$/i.test(u.hostname)?u:null
  }catch{return null}
}
const complete=(r:ObservedHttpResult|null|undefined,u:string):r is ObservedHttpResult=>
  !!r&&r.finalUrl===u&&r.complete&&!r.location&&!r.truncated&&r.contentEncoding==='identity'&&
  typeof r.body==='string'&&r.body.length<=MAX_BYTES&&Buffer.byteLength(r.body)<=MAX_BYTES
const jsonMime=/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i
const mime=(kind:'html'|'plain',s:string|null)=>new RegExp(`^text/${kind}(?:\\s*;\\s*charset\\s*=\\s*"?utf-8"?)?\\s*$`,'i').test(s??'')
function bounded<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T|undefined>{
  if(signal.aborted)return Promise.resolve(undefined)
  return new Promise(resolve=>{
    const abort=()=>finish(undefined)
    const finish=(v:T|undefined)=>{signal.removeEventListener('abort',abort);resolve(v)}
    signal.addEventListener('abort',abort,{once:true})
    void Promise.resolve().then(()=>signal.aborted?undefined:operation()).then(finish,()=>finish(undefined))
  })
}
type Node=DefaultTreeAdapterMap['node']
type Element=DefaultTreeAdapterMap['element']
const children=(n:Node):readonly Node[]=>'childNodes'in n?n.childNodes:[]
const attribute=(n:Element,k:string)=>n.attrs.find(x=>x.name===k)?.value
const opaque=new Set(['script','style','noscript','template','iframe','textarea','dialog','svg','math','object','embed'])
function homepageLinksExactPosting(html:string,companyName:string,posting:string):boolean{
  const doc=parse(html,{scriptingEnabled:true,sourceCodeLocationInfo:true})
  const stack=children(doc).map(node=>({node,body:false}))
  let h1=0, links=0,n=0
  while(stack.length){
    const x=stack.pop()
    if(!x||++n>10_000)return false
    const {node,body}=x
    const el='tagName' in node?node:null
    if(el){
      const tag=el.tagName
      if(tag==='meta'&&attribute(el,'http-equiv')?.trim().toLowerCase()==='refresh')return false
      if(opaque.has(tag)||attribute(el,'hidden')!==undefined||attribute(el,'inert')!==undefined||attribute(el,'style')!==undefined||
          attribute(el,'aria-hidden')?.trim().toLowerCase()==='true'||
          /(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|d-none)(?:\s|$)/i.test(attribute(el,'class')??'')||
          (tag==='details'&&attribute(el,'open')===undefined))continue
      const parts=children(el)
      const plain=parts.length===1&&parts[0].nodeName==='#text'&&'value'in parts[0]?nfc(parts[0].value):''
      const source=el.sourceCodeLocation
      if(body&&tag==='h1'){
        if(!source?.startTag||!source.endTag||plain!==nfc(companyName))return false
        h1++
      }
      if(body&&tag==='a'&&attribute(el,'href')===posting&&plain&&source?.startTag&&source.endTag){
        // Require literal same pathname URL, not rewritten DOM/redirect/meta,
        // affiliate tracking link or an ATS publisher label without a link.
        if(!html.slice(source.startTag.startOffset,source.startTag.endOffset).includes(posting))return false
        links++
      }
    }
    const within=body||el?.tagName==='body'
    for(const child of children(node))stack.push({node:child,body:within})
  }
  return h1===1&&links===1
}

export async function proveReciprocalCompanySite(policy:Readonly<{enabled?:boolean;signal:AbortSignal}>,rawScope:Scope,rawCandidate:Candidate,
  authority:ReciprocalSiteAuthority,wire:ObservedSafeGet=observedSafeGet):Promise<WebsiteProof>{
  if(policy.enabled!==true)return {state:'held',reason:'disabled'}
  const scope=Object.freeze({tenant:rawScope.tenant,job:rawScope.job,attempt:rawScope.attempt})
  const candidate=Object.freeze({name:rawCandidate.name,hintUrl:rawCandidate.hintUrl})
  const posting=publicUrl(candidate.hintUrl)
  const ref=posting&&atsPostingRef(posting.href)
  if(!posting||!ref||ref.kind!=='greenhouse'||!short(candidate.name)||!Object.values(scope).every(x=>short(x))||policy.signal.aborted)return HELD
  const signal=AbortSignal.any([policy.signal,AbortSignal.timeout(20_000)])
  const current=async ()=>{
    const b=await bounded(signal,()=>authority.readCurrentNativePosting(scope,candidate,signal))
    return !signal.aborted&&b&&eq(b.scope,scope)&&b.candidateName===candidate.name&&b.exactPostingUrl===posting.href&&
      short(b.settledCallId,100)&&Number.isSafeInteger(b.expiresAtMs)&&b.expiresAtMs>Date.now()
      ? Object.freeze({settledCallId:b.settledCallId,expiresAtMs:b.expiresAtMs}) : null
  }
  const initial=await current()
  if(!initial)return HELD
  const stillCurrent=async ()=>{
    const r=await current()
    return !!r&&r.settledCallId===initial.settledCallId&&r.expiresAtMs===initial.expiresAtMs
  }
  const reserve=async (url:string,step:'publisher'|'robots'|'homepage',s:AbortSignal)=>
    await stillCurrent()&&!s.aborted&&await bounded(s,()=>authority.reserveCurrentRead(Object.freeze({scope,settledCallId:initial.settledCallId,exactUrl:url,step,signal:s})))===true&&!s.aborted
  const api=atsRecordUrl(ref)
  if(!await reserve(api,'publisher',signal))return {state:'held',reason:'reservation_unavailable'}
  const res=await bounded(signal,()=>wire(api,{accept:'application/json',userAgent:UA,signal}))
  if(!complete(res,api)||res.status!==200||!jsonMime.test(res.contentType??'')||!await stillCurrent())return HELD
  let target:URL|null=null
  let expected:Readonly<{title:string;day:string;deadline:string|null}>|null=null
  try{
    const raw:unknown=JSON.parse(res.body)
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return HELD
    const row=raw as Record<string,unknown>
    const record=atsRecord(raw,ref)
    if(!record||record==='missing'||!short(row.company_name)||nfc(row.company_name)!==nfc(candidate.name)||
        row.closed===true||row.archived===true||!isCurrentCompanyFirstDeadline(row.application_deadline,Date.now()))return HELD
    target=publicUrl(row.absolute_url,ref.id)
    if(record.posted&&record.title)expected=Object.freeze({title:record.title,day:record.posted,deadline:typeof row.application_deadline==='string'?row.application_deadline:null})
  }catch{return HELD}
  const targetDomain=target&&getDomain(target.hostname,{allowPrivateDomains:true})
  const vendorDomain=getDomain(posting.hostname,{allowPrivateDomains:true})
  if(!target||!targetDomain||targetDomain===vendorDomain||target.pathname==='/'||ownSiteHost(target.href)!==targetDomain)return HELD
  const home=new URL('/',target.origin)
  const companyKey=createHash('sha256').update(JSON.stringify([ref.kind,ref.org,target.origin])).digest('hex')
  const result=await verifyCompanyWebsite({enabled:true,signal},scope,candidate,{
    parsePage:htmlToText,parseRobots,
    async readIndependentOrigin(q){
      if(!eq(q.scope,scope)||q.exactHintUrl!==posting.href||q.candidateName!==candidate.name||!await stillCurrent())return null
      return {scope,version:initial.settledCallId,expiresAtMs:initial.expiresAtMs,candidateName:candidate.name,companyKey,
        basis:'independent_official_origin',origin:home.origin,identityUrl:home.href,
        hintBinding:{kind:'independently_reviewed_exact_hint',exactHintUrl:posting.href,companyKey}}
    },
    authorizeAndReserve:r=>eq(r.scope,scope)&&r.reviewVersion===initial.settledCallId
      ? reserve(r.exactUrl,r.kind==='robots'?'robots':'homepage',r.signal) : Promise.resolve(false),
    async read(url,opts){
      const robots=url===new URL('/robots.txt',home).href
      if(!robots&&url!==home.href)return null
      const r=await wire(url,{accept:robots?'text/plain':'text/html',userAgent:UA,signal:opts?.signal})
      if(!complete(r,url)||!await stillCurrent())return null
      if(robots&&(r.status===404||r.status===410))return {status:r.status,body:''}
      if(r.status!==200||!mime(robots?'plain':'html',r.contentType)|| (robots
        ? /<\s*(?:!doctype|html|body|script)\b/i.test(r.body)
        : !homepageLinksExactPosting(r.body,candidate.name,posting.href)))return null
      return {status:r.status,body:r.body}
    },
  })
  if(result.state!=='verified')return result
  // Contact is still impossible until the exact linked posting is re-read by
  // the ordinary dated/canonical signal verifiers and all later holds pass.
  const site=Object.freeze({...result.site,posting:Object.freeze({linkSource:home.href,postingUrl:posting.href})})
  issued.set(site,Object.freeze({scope,version:initial.settledCallId,expiresAtMs:initial.expiresAtMs,companyKey,
    companyName:candidate.name,websiteOrigin:home.origin,kind:'observed_owned_link',
    linkSource:home.href,literalPostingHref:posting.href}))
  // Query-bearing embeds are not accepted by the exact public page reader.
  // Do not strip the parameter: that could name another posting.
  if(expected&&!target.search)permalinks.set(site,Object.freeze({url:target.href,...expected}))
  return {state:'verified',site}
}
