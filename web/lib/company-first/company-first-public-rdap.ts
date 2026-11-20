// Private company-first corroboration only. Not a website, office, or lead verdict.
import { parse } from 'tldts'
import { observedSafeGet, type ObservedSafeGet } from '../sources/http.ts'
import type { Scope } from './company-first-evidence.ts'

const BOOTSTRAP='https://data.iana.org/rdap/dns.json'
const UA='dazl-contact-check/1.0 (+https://dazl.ai)'
const RDAP_MIME=/^application\/rdap\+json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i
const BOOT_MIME=/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i
const NAME=/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])$/
const LABEL=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const NO_NAME=/(?:\bredact(?:ed|ion)?\b|\bprivacy\b|\bprivate registration\b|\bproxy\b|\bregistration service\b|\bnot disclosed\b|\bdata protected\b|^n\/?a$)/i
const basename=(x:string)=>x.normalize('NFC').replace(/\s+/gu,' ').toLowerCase()
const clean=(x:unknown,max=200):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&x.trim()===x&&!/[\p{C}]/u.test(x)
const orgName=(x:unknown):x is string=>clean(x)&&!NO_NAME.test(x)&&!/[<>@]/u.test(x)&&/\p{L}/u.test(x)
const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)
const same=(a:Scope,b:Scope)=>a?.tenant===b.tenant&&a?.job===b.job&&a?.attempt===b.attempt
const until=(x:unknown,at:number):x is number=>Number.isSafeInteger(x)&&(x as number)>at
function date(v:unknown){
  if(typeof v!=='string'||!ISO.test(v))return NaN
  const n=Date.parse(v)
  return Number.isFinite(n)&&new Date(n).toISOString().slice(0,19)===v.slice(0,19)?n:NaN
}
const domainName=(v:string)=>v.length<=253&&NAME.test(v)&&v.split('.').every(x=>LABEL.test(x))
function exactDomain(v:string){
  if(!domainName(v))return false
  const p=parse(v,{allowPrivateDomains:true,validateHostname:true})
  return p.isIcann===true&&p.isPrivate!==true&&p.domain===v&&p.hostname===v
}
function baseUrl(raw:unknown):URL|null{
  if(!clean(raw,350)||/[\s\\%?#]/.test(raw))return null
  try{
    const u=new URL(raw)
    return u.href===raw&&u.protocol==='https:'&&domainName(u.hostname)&&!u.port&&!u.username&&!u.password&&
      !/\.(?:localhost|local|internal|onion|test|invalid)$/i.test(u.hostname)&&
      /^\/(?:[A-Za-z0-9_.~-]+\/)*$/.test(u.pathname)?u:null
  }catch{return null}
}

type Qualification=Readonly<{
  // Registry-specific documented direct-public-registrant signal. The RFC
  // role alone cannot identify a privacy provider which omits a proxy role.
  // Exact fresh reviewed structural condition; no model or generic fallback.
  field: string; equals: string | boolean
}>
export type ReviewedRdapPrefix=Readonly<{
  exactBaseUrl:string; reviewVersion:string; expiresAtMs:number
  directPublicRegistrant:Qualification
}>
export type RdapBinding=Readonly<{
  scope:Scope; registrableDomain:string; expectedOrganization:string
  reviewVersion:string; expiresAtMs:number
}>
export interface PublicRdapAuthority{
  isCurrent(scope:Scope):Promise<boolean>
  // Durable shared per-origin cadence/cooldown. Must use reviewed server
  // limits and refuse unknown policies or a prior quota hold.
  reserveCurrentRead(x:Readonly<{scope:Scope; exactUrl:string; step:'bootstrap'|'rdap'; reviewVersion:string;signal:AbortSignal}>):Promise<boolean>
  // Persistent quarantine until reviewed recovery, since the guarded reader
  // does not expose Retry-After. Never retry another server or rotate IPs.
  suspendOrigin(x:Readonly<{scope:Scope;origin:string;status:429}>):Promise<void>
}
export type PublicRdapRegistrant=Readonly<{
  kind:'public_rdap_registrant_org'; scope:Scope; registrableDomain:string; organization:string;
  exactSourceUrl:string; registryBaseUrl:string; reviewVersion:string; checkedAtMs:number; expiresAtMs:number
}>
const issued=new WeakSet<object>()
export function isPublicRdapRegistrantFor(x:PublicRdapRegistrant|null,scope:Scope,domain:string,now=Date.now()):boolean{
  return !!x&&issued.has(x)&&same(x.scope,scope)&&x.registrableDomain===domain&&x.checkedAtMs<=now&&x.expiresAtMs>now
}

// Bounded standard JSON with duplicate keys refused (including escaped
// equivalents); JSON.parse alone overwrites later authority fields.
function json(raw:string):unknown {
  let i=0,n=0
  const bad=()=>{throw new SyntaxError('invalid registry payload')}
  const wsp=()=>{while(/[ \t\r\n]/.test(raw[i]??''))i++}
  function quoted():string{
    if(raw[i]!=='"')return bad()
    const start=i++
    while(i<raw.length){const c=raw[i++];if(c==='"')return JSON.parse(raw.slice(start,i)) as string;if(c==='\\')i++}
    return bad()
  }
  function walk(depth:number):void{
    if(depth>20||++n>16_000)return bad()
    wsp();if(raw[i]==='"'){quoted();return}
    if(raw[i]==='{'||raw[i]==='['){
      const map=raw[i++]==='{',end=map?'}':']',keys=new Set<string>()
      wsp();if(raw[i]===end){i++;return}
      do{
        wsp();if(map){const k=quoted();if(keys.has(k))return bad();keys.add(k);wsp();if(raw[i++]!==':')return bad()}
        walk(depth+1);wsp();if(raw[i]===end){i++;return}
      }while(raw[i++]===',')
      return bad()
    }
    const start=i;while(i<raw.length&&!/[ \t\r\n,}\]]/.test(raw[i]))i++
    if(i===start)return bad()
  }
  walk(0);wsp();if(i!==raw.length)return bad()
  return JSON.parse(raw)
}
function pinBootstrap(raw:unknown, domain:string, reviewed:URL, time:number):boolean {
  if(!obj(raw)||raw.version!=='1.0'||!(date(raw.publication)<=time)||!Array.isArray(raw.services)||raw.services.length>1500)return false
  let best=0, hits:unknown[][]=[]
  for(const group of raw.services){
    if(!Array.isArray(group)||group.length!==2||!Array.isArray(group[0])||!Array.isArray(group[1]))return false
    const [suffixes, urls]=group
    if(suffixes.length>1500||urls.length>20)return false
    for(const suffix of suffixes){
      if(typeof suffix!=='string'||!suffix.split('.').every(x=>LABEL.test(x)))return false
      if(domain!==suffix&&!domain.endsWith('.'+suffix))continue
      const n=suffix.split('.').length
      if(n>best){best=n;hits=[urls]}else if(n===best){hits.push(urls)}
    }
  }
  return hits.length===1&&hits[0].filter(v=>v===reviewed.href).length===1
}
function redacted(x:Record<string,unknown>):boolean{
  if(Object.hasOwn(x,'redacted')&&(!Array.isArray(x.redacted)||x.redacted.length>0))return true
  // Any nonstandard obvious privacy/proxy hint holds; the independently
  // reviewed affirmative direct-only field is still mandatory.
  for(const k of ['notices','remarks','status']){
    const v=x[k]
    if(v!==undefined&&(!Array.isArray(v)||JSON.stringify(v).length>12_000||
      /redact|privacy|private registration|registration proxy|proxy service|masked|withheld/i.test(JSON.stringify(v))))return true
  }
  return false
}
function decode(raw:unknown,b:RdapBinding,rule:Qualification,now:number):{organization:string;expiresAtMs:number}|null{
  if(!obj(raw)||raw.objectClassName!=='domain'||raw.ldhName!==b.registrableDomain||
    !Array.isArray(raw.rdapConformance)||!raw.rdapConformance.includes('rdap_level_0')||redacted(raw)||
    !Array.isArray(raw.entities)||raw.entities.length>40||!Array.isArray(raw.events)||raw.events.length>40)return null
  if(Array.isArray(raw.status)&&raw.status.some(s=>typeof s!=='string'||/pending (?:delete|transfer)|redemption|inactive|expired/i.test(s)))return null
  const expiry=raw.events.filter(e=>obj(e)&&e.eventAction==='expiration')
  if(expiry.length!==1||!obj(expiry[0]))return null
  const expiresAtMs=date(expiry[0].eventDate)
  if(!(expiresAtMs>now))return null
  const scoped=raw.entities.filter(e=>obj(e)&&Array.isArray(e.roles)&&e.roles.includes('registrant'))
  // Fail on explicit proxy anywhere in the immediate domain-related entities,
  // including a separately listed role, not just alongside the registrant.
  if(raw.entities.some(e=>!obj(e)||!Array.isArray(e.roles)||e.roles.some(x=>typeof x!=='string'||x==='proxy'))||
    scoped.length!==1||!obj(scoped[0]))return null
  const e=scoped[0]
  if(e.objectClassName!=='entity'||!Array.isArray(e.roles)||e.roles.length!==1||
    (Array.isArray(e.entities)?e.entities.length!==0:e.entities!==undefined)||redacted(e)||
    !Object.hasOwn(e,rule.field)||e[rule.field]!==rule.equals||
    !Array.isArray(e.vcardArray)||e.vcardArray.length!==2||e.vcardArray[0]!=='vcard'||
    !Array.isArray(e.vcardArray[1])||e.vcardArray[1].length>64)return null
  const rows=e.vcardArray[1]
  const fields=(type:string)=>rows.filter(v=>Array.isArray(v)&&v[0]===type)
  function one(name:string):unknown{
    const values=fields(name)
    if(values.length!==1)return undefined
    const v=values[0]
    return v.length===4&&obj(v[1])&&Object.keys(v[1]).length===0&&v[2]==='text'?v[3]:undefined
  }
  const organization=one('org')
  return one('kind')==='org'&&orgName(organization)&&basename(organization)===basename(b.expectedOrganization)
    ?{organization,expiresAtMs}:null
}

function bounded<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T|null>{
  if(signal.aborted)return Promise.resolve(null)
  return new Promise(resolve=>{
    const stop=()=>done(null)
    const done=(v:T|null)=>{signal.removeEventListener('abort',stop);resolve(v)}
    signal.addEventListener('abort',stop,{once:true})
    void Promise.resolve().then(()=>signal.aborted?null:work()).then(done,()=>done(null))
  })
}
export function createPublicRdapRegistrantReader(
  review:ReviewedRdapPrefix|null,binding:RdapBinding|null,authority:PublicRdapAuthority,
  transport:ObservedSafeGet=observedSafeGet,clock=Date.now,
):(signal:AbortSignal)=>Promise<PublicRdapRegistrant|null>{
  const none=async()=>null
  if(!review||!binding||!authority||!review.directPublicRegistrant)return none
  const b=Object.freeze({...binding,scope:Object.freeze({...binding.scope})})
  const approved=Object.freeze({...review,directPublicRegistrant:Object.freeze({...review.directPublicRegistrant})})
  const base=baseUrl(approved.exactBaseUrl),rule=approved.directPublicRegistrant
  const cut=Math.min(approved.expiresAtMs,b.expiresAtMs)
  const reservedFields=new Set(['objectClassName','roles','vcardArray','handle','links','status','entities','remarks','notices','redacted','__proto__','constructor','prototype'])
  if(!base||!clean(b.registrableDomain,253)||!exactDomain(b.registrableDomain)||!orgName(b.expectedOrganization)||
    ![b.scope.tenant,b.scope.job,b.scope.attempt,b.reviewVersion].every(v=>clean(v))||
    b.reviewVersion!==approved.reviewVersion||!until(cut,clock())||
    typeof rule.field!=='string'||!/^[a-z][a-z0-9_]{2,70}$/i.test(rule.field)||reservedFields.has(rule.field)||
    !(typeof rule.equals==='boolean'&&(rule.equals===true)||clean(rule.equals,80)))return none
  const record=new URL('domain/'+b.registrableDomain,base)
  let attempted=false
  return async caller=>{
    if(caller.aborted||attempted||clock()>=cut)return null
    attempted=true
    const signal=AbortSignal.any([caller,AbortSignal.timeout(12_000)])
    async function read(exactUrl:string,step:'bootstrap'|'rdap'){
      if(signal.aborted||clock()>=cut||await bounded(signal,()=>authority.isCurrent(b.scope))!==true||
        await bounded(signal,()=>authority.reserveCurrentRead(Object.freeze({scope:b.scope,exactUrl,step,reviewVersion:b.reviewVersion,signal})))!==true||
        signal.aborted||clock()>=cut)return null
      const accept=step==='bootstrap'?'application/json':'application/rdap+json'
      const r=await bounded(signal,()=>transport(exactUrl,{accept,userAgent:UA,signal}))
      if(r?.status===429&&r.finalUrl===exactUrl){
        // Once a quota reply is observed, persist its hold even if the
        // caller cancels or the composite deadline has just elapsed.
        await bounded(AbortSignal.timeout(1_000),()=>authority.suspendOrigin(Object.freeze({scope:b.scope,origin:new URL(exactUrl).origin,status:429})))
        return null
      }
      if(!r||signal.aborted||r.status!==200||r.finalUrl!==exactUrl||r.truncated||r.location||!r.complete||
        r.contentEncoding!=='identity'||!(step==='bootstrap'?BOOT_MIME:RDAP_MIME).test(r.contentType??'')||
        typeof r.body!=='string'||Buffer.byteLength(r.body,'utf8')>128_000)return null
      return json(r.body)
    }
    try{
      if(!pinBootstrap(await read(BOOTSTRAP,'bootstrap'),b.registrableDomain,base,clock()))return null
      const result=decode(await read(record.href,'rdap'),b,rule,clock())
      if(!result||await bounded(signal,()=>authority.isCurrent(b.scope))!==true||signal.aborted)return null
      const checkedAtMs=clock(),expiresAtMs=Math.min(cut,result.expiresAtMs,checkedAtMs+120_000)
      if(!until(expiresAtMs,checkedAtMs))return null
      const out:PublicRdapRegistrant=Object.freeze({kind:'public_rdap_registrant_org',scope:b.scope,
        registrableDomain:b.registrableDomain,organization:result.organization,exactSourceUrl:record.href,
        registryBaseUrl:base.href,reviewVersion:b.reviewVersion,checkedAtMs,expiresAtMs})
      issued.add(out)
      return out
    }catch{return null}
  }
}
