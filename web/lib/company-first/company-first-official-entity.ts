// Additive server-only registry adapter. No production provider or scope
// configured here: callers must bind separate reviewed, scope-specific data.
import { createHash } from 'node:crypto'
import { observedSafeGet, type ObservedSafeGet } from '../sources/http.ts'
import type { Scope } from './company-first-evidence.ts'
import type { IndependentEntity, OriginIssuerPorts } from './company-first-origin-issuer.ts'

type Path = readonly string[]
const keys = ['id','legalName','revision','state','validUntilMs','homepage','establishmentRole','officeCode','countryCode',
  'street','locality','region','postal','country'] as const
type Field = typeof keys[number]

export type ReviewedOfficialRegistry = Readonly<{
  issuerKey:string; jurisdictionKey:string; reviewVersion:string; expiresAtMs:number
  authorityOrigin:string; recordPathPrefix:string
  recordList:Path
  fields:Readonly<Record<Field,Path>>
  activeState:string
  // Exact reviewed provider classification, not a catch-all address role.
  establishmentRole:string
}>
export type ReviewedEntityBinding = Readonly<{
  scope:Scope; issuerKey:string; jurisdictionKey:string; registryReviewVersion:string; expiresAtMs:number
  legalId:string; legalName:string; recordRevision:string; exactRecordUrl:string
  exactHomepage:string; exactOwnedIdentityUrl:string; exactLinkedHintUrl?:string
  // Supplied by independent reviewed canonical mapping, never the LLM hint,
  // string extraction from the address, or an implicit country fallback.
  placeKey:string; countryKey:string; officialOfficeCode:string; officialCountryCode:string
}>
export interface OfficialRegistryReadAuthority {
  isCurrent(scope:Scope):Promise<boolean>
  reserveCurrentRegistryRead(x:Readonly<{scope:Scope;exactUrl:string;reviewVersion:string;signal:AbortSignal}>):Promise<boolean>
}
type ReadRecords = OriginIssuerPorts['readIndependentRecords']
const NONE:ReadRecords = async () => null
const UA='dazl-contact-check/1.0 (+https://dazl.ai)'
const MAX_BODY=64_000
const JSON_MIME=/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i
const short=(v:unknown,max=200):v is string=>typeof v==='string' && v.length>0 && v.length<=max && v.trim()===v && !/[\p{C}]/u.test(v)
const placeFold=(x:string)=>x.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()
const digest=(...x:string[])=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const isPlainObject=(x:unknown):x is Record<string,unknown>=>!!x && typeof x==='object' && !Array.isArray(x)
function url(v:unknown):URL|null {
  if(!short(v,480)||/[\s\\?#]|%/u.test(v))return null
  try{
    const u=new URL(v)
    if(u.href!==v||u.protocol!=='https:'||u.username||u.password||u.port||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)||
      /\.(?:localhost|local|internal|onion|test|invalid)$/i.test(u.hostname))return null
    return u
  }catch{return null}
}
const same=(a:Scope,b:Scope)=>a?.tenant===b.tenant && a?.job===b.job && a?.attempt===b.attempt
const live=(v:unknown,now:number):v is number=>Number.isSafeInteger(v) && (v as number)>now
function freezePath(x:unknown,allowRoot=false):Path|null {
  return Array.isArray(x) && x.length<7 && (allowRoot||x.length>0) &&
    x.every(v=>typeof v==='string'&&/^[A-Za-z0-9_.-]{1,60}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v)) ? Object.freeze([...x]) : null
}
function at(x:unknown,p:Path):unknown {
  for(const k of p){if(!isPlainObject(x)||!Object.hasOwn(x,k))return undefined;x=x[k]}
  return x
}

/** JSON.parse alone silently overwrites duplicate authoritative members (even
 * escaped equivalents). A bounded structural pass refuses them before mapping.
 * The standard parser then supplies semantic data; no regex field extraction. */
function strictJson(raw:string):unknown {
  let i=0, nodes=0
  const bad=()=>{throw new SyntaxError('unsupported registry JSON')}
  function space(){while(i<raw.length && /[ \n\r\t]/.test(raw[i]))i++}
  function quoted():string{
    if(raw[i]!=='"')return bad()
    const start=i++
    while(i<raw.length){
      const c=raw[i++]
      if(c==='"')return JSON.parse(raw.slice(start,i)) as string
      if(c==='\\')i++
    }
    return bad()
  }
  function scan(depth:number):void {
    if(depth>15||++nodes>4000)return bad()
    space()
    if(raw[i]==='"'){quoted();return}
    if(raw[i]==='{'||raw[i]==='['){
      const object=raw[i++]==='{',close=object?'}':']',seen=new Set<string>()
      space();if(raw[i]===close){i++;return}
      do{
        space()
        if(object){
          const k=quoted();if(seen.has(k))return bad();seen.add(k)
          space();if(raw[i++]!==':')return bad()
        }
        scan(depth+1);space()
        if(raw[i]===close){i++;return}
      }while(raw[i++]===',')
      return bad()
    }
    const start=i
    while(i<raw.length && !/[ \t\r\n,}\]]/.test(raw[i]))i++
    if(i===start)return bad()
  }
  scan(0);space();if(i!==raw.length)return bad()
  return JSON.parse(raw)
}

function bounded<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T|null>{
  if(signal.aborted)return Promise.resolve(null)
  return new Promise(resolve=>{
    const stop=()=>done(null)
    const done=(value:T|null)=>{signal.removeEventListener('abort',stop);resolve(value)}
    signal.addEventListener('abort',stop,{once:true})
    void Promise.resolve().then(()=>signal.aborted?null:work()).then(done,()=>done(null))
  })
}

const verifiedOfficialRecords=new WeakSet<IndependentEntity>()
export function isVerifiedOfficialEntity(record:IndependentEntity|undefined):boolean {
  return !!record && verifiedOfficialRecords.has(record)
}
export function officialCompanyEntityKey(id:IndependentEntity['legalIdentity']):string{
  return digest(id.issuerKey,id.jurisdictionKey,id.legalId)
}

export function createOfficialEntityReader(
  registry:ReviewedOfficialRegistry|null,
  binding:ReviewedEntityBinding|null,
  authority:OfficialRegistryReadAuthority,
  transport:ObservedSafeGet=observedSafeGet,
  clock=Date.now,
):ReadRecords {
  if(!registry||!binding||!authority)return NONE
  const config=Object.freeze({...registry}), b=Object.freeze({...binding,scope:Object.freeze({...binding.scope})})
  const origin=url(config.authorityOrigin+'/'), record=url(b.exactRecordUrl), home=url(b.exactHomepage), identity=url(b.exactOwnedIdentityUrl)
  const hint=b.exactLinkedHintUrl===undefined?null:url(b.exactLinkedHintUrl)
  if(!origin||!record||!home||!identity||origin.origin!==config.authorityOrigin||record.origin!==origin.origin||
    identity.origin!==home.origin||origin.origin===home.origin||home.pathname!=='/'||identity.pathname==='/robots.txt'||
    !/^\/(?:[A-Za-z0-9_.-]+\/)+$/.test(config.recordPathPrefix)||
    !record.pathname.startsWith(config.recordPathPrefix)||record.pathname===config.recordPathPrefix||
    (b.exactLinkedHintUrl!==undefined&&!hint))return NONE
  if(![config.issuerKey,config.jurisdictionKey,config.reviewVersion,config.activeState,config.establishmentRole].every(x=>short(x,100))||
    ![b.legalId,b.recordRevision].every(x=>short(x,100))||b.legalId.length<3||
    ![b.legalName,b.placeKey,b.countryKey,b.officialOfficeCode,b.officialCountryCode,b.scope?.tenant,b.scope?.job,b.scope?.attempt].every(x=>short(x))||
    b.issuerKey!==config.issuerKey||b.jurisdictionKey!==config.jurisdictionKey||b.registryReviewVersion!==config.reviewVersion||
    !live(config.expiresAtMs,clock())||!live(b.expiresAtMs,clock()))return NONE
  const recordList=freezePath(config.recordList,true)
  const mapped=keys.map(k=>freezePath(config.fields?.[k]))
  if(!recordList||mapped.some(p=>!p)||new Set(mapped.map(p=>JSON.stringify(p))).size!==keys.length)return NONE
  const fields=Object.freeze(Object.fromEntries(keys.map((k,i)=>[k,mapped[i]]))) as Readonly<Record<Field,Path>>
  const expires=Math.min(config.expiresAtMs,b.expiresAtMs)
  const reviewVersion=digest(config.reviewVersion,b.recordRevision)
  const companyKey=officialCompanyEntityKey({issuerKey:config.issuerKey,jurisdictionKey:config.jurisdictionKey,legalId:b.legalId})
  let dispatches=0
  return async (q,callerSignal)=>{
    if(!same(q.scope,b.scope)||url(q.exactHintUrl)?.origin!==q.hintedOrigin||!short(q.candidateName)||placeFold(q.candidateName)!==placeFold(b.legalName)||
      (q.requiredPlaceKey!==undefined&&q.requiredPlaceKey!==b.placeKey)||
      (q.hintedOrigin!==home.origin&&q.exactHintUrl!==hint?.href)||
      (hint!==null&&q.exactHintUrl!==hint.href)||callerSignal.aborted||clock()>=expires||dispatches>=2)return null
    const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(6_000)])
    // Count any attempt to dispatch; failures cannot cause an unbounded retry.
    dispatches++
    if(await bounded(signal,()=>authority.isCurrent(b.scope))!==true||clock()>=expires||signal.aborted||
      await bounded(signal,()=>authority.reserveCurrentRegistryRead(Object.freeze({scope:b.scope,exactUrl:record.href,reviewVersion,signal})))!==true||
      clock()>=expires||signal.aborted)return null
    const r=await bounded(signal,()=>transport(record.href,{accept:'application/json',userAgent:UA,signal}))
    if(!r||r.status!==200||r.finalUrl!==record.href||r.location||r.contentEncoding!=='identity'||
      !r.complete||r.truncated||!JSON_MIME.test(r.contentType??'')||
      typeof r.body!=='string'||r.body.length>MAX_BODY||Buffer.byteLength(r.body,'utf8')>MAX_BODY||signal.aborted||clock()>=expires)return null
    try{
      const records=at(strictJson(r.body),recordList)
      if(!Array.isArray(records)||records.length!==1||!isPlainObject(records[0]))return null
      const rec=records[0]
      const value=(k:Field)=>at(rec,fields[k])
      const legalName=value('legalName'), until=value('validUntilMs'), websiteField=value('homepage')
      if(value('id')!==b.legalId||!short(legalName)||placeFold(legalName)!==placeFold(b.legalName)||
        value('revision')!==b.recordRevision||value('state')!==config.activeState||!live(until,clock())||
        websiteField!==home.href||value('establishmentRole')!==config.establishmentRole||
        value('officeCode')!==b.officialOfficeCode||value('countryCode')!==b.officialCountryCode)return null
      const street=value('street'),locality=value('locality'),region=value('region'),postal=value('postal'),country=value('country')
      if(!short(street)||!short(locality)||!short(region)||!short(postal)||!short(country)||
        await bounded(signal,()=>authority.isCurrent(b.scope))!==true||clock()>=Math.min(until,expires)||signal.aborted)return null
      const provenance:IndependentEntity=Object.freeze({
        scope:b.scope,reviewVersion,expiresAtMs:Math.min(until,expires),companyKey,legalName,
        legalIdentity:Object.freeze({issuerKey:config.issuerKey,jurisdictionKey:config.jurisdictionKey,legalId:b.legalId}),
        recordAuthorityOrigin:origin.origin,exactSourceRecordUrl:record.href,websiteField:home.href,exactOwnedIdentityUrl:identity.href,
        ...(hint?{exactLinkedHintUrl:hint.href}:{}),
        canonicalOffice:Object.freeze({placeKey:b.placeKey,countryKey:b.countryKey,street,locality,region,postal,country}),
      })
      verifiedOfficialRecords.add(provenance)
      return Object.freeze([provenance])
    }catch{return null}
  }
}
