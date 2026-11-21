import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { siteKey } from './intelligence.ts'
import { consumeWebsiteReviewAudit, pendingWebsiteReviewSnapshot, storedWebsiteReviewSnapshot } from './store.ts'

type Scope=Readonly<{tenantId:string;actorId:string}>
type Snapshot=Readonly<{query:string;offer:string;icpJson:string}>
type Receipt={v:1;k:'site'|'approval';tenant:string;actor:string;nonce:string;until:number;source:string;digest?:string}
type Approved=Readonly<{scope:Scope;nonce:string;until:number;digest:string}>
const authenticated=new WeakSet<Approved>()
export const WEBSITE_PROFILE_REVIEW_MODE='website_profile_review_v1'
export const WEBSITE_PROFILE_REVIEW_ACTION='scan.website_profile.review_confirmed'
// Audit id is derived per tenant and job for indexed polling, not a new exposed identifier.
const queuedAuditId=(tenantId:string,jobId:string)=>createHash('sha256').update(JSON.stringify(['website-profile-review/v1',tenantId,jobId])).digest('hex').slice(0,24)
const revision=(s:Snapshot)=>createHash('sha256').update(JSON.stringify([s.query,s.offer,s.icpJson])).digest('hex')
function mac(key:Buffer,serialized:string){
  return createHmac('sha256',key).update('dazl/website-profile-review/v1\0'+serialized).digest()
}
function sign(key:Buffer,body:Receipt) {
  const b=Buffer.from(JSON.stringify(body)).toString('base64url')
  return b+'.'+mac(key,b).toString('base64url')
}
function read(key:Buffer, value:unknown, scope:Scope, now:number):Receipt|null {
  try{
    if(!Number.isSafeInteger(now)||typeof value!=='string'||value.length>1024||
       !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{43}$/.test(value))return null
    const [b,sig]=value.split('.')
    const signature=Buffer.from(sig,'base64url')
    if(signature.toString('base64url')!==sig||!timingSafeEqual(mac(key,b),signature))return null
    const t=JSON.parse(Buffer.from(b,'base64url').toString('utf8')) as Receipt
    return t?.v===1&&t.tenant===scope.tenantId&&t.actor===scope.actorId&&/^[a-f0-9]{24}$/.test(t.nonce)&&
      Number.isSafeInteger(t.until)&&t.until>now?t:null
  }catch{return null}
}
/** Invoke only inside the authenticated actual website route on a successful
 * draft response backed by its verified fetched page; no owner claim. */
export function issueWebsiteDraftReceipt(key:Buffer,scope:Scope,sourceUrl:string,now=Date.now()):string|null{
  const source=siteKey(sourceUrl)
  if(!source)return null
  return sign(key,{v:1,k:'site',tenant:scope.tenantId,actor:scope.actorId,nonce:randomBytes(12).toString('hex'),source,until:now+20*60_000})
}
/** Invoke only on explicit authorized review of the canonical exact snapshot.
 * A quote authorizes no spend; standard estimate confirmation is still separate. */
export function issueWebsiteApproval(key:Buffer,scope:Scope,draft:unknown,snapshot:Snapshot,now=Date.now()):string|null{
  const source=read(key,draft,scope,now)
  if(source?.k!=='site')return null
  try {
    const saved = JSON.parse(snapshot.icpJson) as {research?:{site?:unknown}}
    if (typeof saved.research?.site!=='string'||siteKey(saved.research.site)!==source.source) return null
  } catch { return null }
  return sign(key,{...source,k:'approval',until:Math.min(source.until,now+5*60_000),digest:revision(snapshot)})
}
export function verifyWebsiteApproval(key:Buffer,scope:Scope,receipt:unknown,snapshot:Snapshot,now=Date.now()):Approved|null{
  const r=read(key,receipt,scope,now)
  if(r?.k!=='approval'||r.digest!==revision(snapshot))return null
  const grant=Object.freeze({scope:Object.freeze({...scope}),nonce:r.nonce,until:r.until,digest:r.digest})
  authenticated.add(grant)
  return grant
}
/** Atomically consume once and attest exactly what the queued job stored; no
 * backfill, source text, receipt secret, raw profile or PII added to audit. */
export function recordQueuedWebsiteApproval(db:Database.Database,proof:Approved,jobId:string,now=Date.now()):boolean{
  if(!db.inTransaction||!authenticated.has(proof)||!Number.isSafeInteger(now)||now>=proof.until)return false
  const {tenantId,actorId}=proof.scope
  const row=pendingWebsiteReviewSnapshot(db, tenantId, jobId)
  if(!row||!row.query||!row.offer||!row.icp||revision({query:row.query,offer:row.offer,icpJson:row.icp})!==proof.digest)return false
  return consumeWebsiteReviewAudit(db,{tenantId,actorId,action:WEBSITE_PROFILE_REVIEW_ACTION,resourceType:'scan_job',resourceId:jobId,
    summary:{receipt_id:proof.nonce,snapshot:'v1:'+proof.digest}},queuedAuditId(tenantId,jobId),Math.floor((now-20*60_000)/1000),proof.nonce,Math.floor(now/1000))
}

/** Canonical current read marker derived only from an actual bound atomic row. */
export function readQueuedWebsiteApproval(db:Database.Database,tenantId:string,jobId:string):boolean{
  try{
    const row=storedWebsiteReviewSnapshot(db,tenantId,jobId,WEBSITE_PROFILE_REVIEW_ACTION,queuedAuditId(tenantId,jobId))
    return !!row&&!!row.query&&!!row.offer&&!!row.icp&&JSON.parse(row.summary).snapshot==='v1:'+revision({query:row.query,offer:row.offer,icpJson:row.icp})
  }catch{return false}
}
