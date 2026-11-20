// Minimal buyer-policy projection for the physically isolated scorecard
// scratch. Not a stage receipt, publication authority, or general DB copy.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { sqliteDb } from '../db/client.ts'
import { getMemory, MEMORY_CAPS, migrateMemory } from '../memory.ts'
import { MAX_COMPETITORS, migrateCompetitors, readCompetitorsStrict } from '../signals/competitor-reddit.ts'
import { authorizeScorecardSubject, SCORECARD_ANCHOR, scorecardPinnedBudget, type ScorecardSubjectInput } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { ownsNewDiscoveryScratch } from './scorecard-evidence-scratch.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'

const PRIVATE='private-scratch'
declare const policyBrand:unique symbol
export type PrivatePolicyContext=Readonly<{[policyBrand]:true}>
type Projection=Readonly<{businessName:string;website:string;competitors:readonly string[];exclusions:readonly string[]}>
type Binding=Readonly<{primary:Database.Database;scratch:Database.Database;execution:AuthorizedScorecardExecution;
  sourceHash:string;projectionHash:string}>
const contexts=new WeakMap<PrivatePolicyContext,Binding>()
const seeded=new WeakSet<Database.Database>()
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(['private-policy-context/v1',x])).digest('hex')
const safeText=(x:unknown,max:number):x is string=>typeof x==='string'&&x.length<=max&&x.trim().length>0&&!/[@\p{Cc}\p{Cf}]/u.test(x)
const site=(x:unknown):string|null=>{
  if(!safeText(x,500))return null
  try{
    const u=new URL(x)
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)&&!u.hostname.endsWith('.local')?u.origin:null
  }catch{return null}
}

async function current(primary:Database.Database,scratch:Database.Database,execution:AuthorizedScorecardExecution,
  reviewed:ScorecardSubjectInput,signal:AbortSignal):Promise<boolean>{
  const t=execution.ticket
  if(signal.aborted||process.env.DAZL_ENV!=='staging'||process.env.DAZL_COMMIT_SHA!==t.release||
    primary===scratch||!scratch.memory||!ownsNewDiscoveryScratch(scratch,primary,t)||!authorizeScorecardSubject(t,reviewed))return false
  const valid=await sqliteDb(primary).tx(function* (tx){
    if(!(yield* requireScorecardWorkspace(tx,t)))return false
    return !!(yield* tx.get(`SELECT 1 FROM scan_jobs j
      JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce AND c.job_id=j.id AND c.tenant_id=j.user_id AND c.attempt=j.attempts
      JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=j.user_id AND p.next_ordinal=c.ordinal
      JOIN users a ON a.id=p.actor_id AND a.email_verified_at IS NOT NULL
      WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.status='running' AND j.error IS NULL AND j.funded_by='user'
        AND j.company_scorecard_dispatch_release=? AND j.company_scorecard_dispatch_started_at IS NOT NULL AND j.business_name=? AND j.run_budget=?
        AND j.query IS NULL AND j.icp IS NULL AND j.seller IS NULL AND j.offer IS NULL AND j.sources IS NULL AND j.icp_inferred IS NULL
        AND j.csv_domain IS NULL AND j.watch_id IS NULL
        AND c.nonce=? AND c.subject_mac=? AND c.status='running' AND c.lane=1 AND c.ordinal=? AND c.cohort=? AND c.expires_at=?
        AND p.release=? AND p.actor_id=? AND p.workspace_revision=? AND p.roster=?`,
    [t.jobId,t.tenantId,t.attempt,t.release,SCORECARD_ANCHOR.business_name,scorecardPinnedBudget(),
      t.nonce,t.subjectMac,t.ordinal,t.cohort,t.expiresAt,t.release,t.actorId,t.workspaceRevision,JSON.stringify(t.presets)]))
  })
  if(!valid||signal.aborted)return false
  const privateJob=await sqliteDb(scratch).get<ScorecardSubjectInput>(`SELECT query,icp,sources,seller,offer FROM scan_jobs
    WHERE id=? AND user_id=? AND attempts=? AND status IN ('running','done') AND error IS NULL
      AND funded_by='user' AND csv_domain IS NULL AND watch_id IS NULL AND run_budget=?`,[t.jobId,PRIVATE,t.attempt,scorecardPinnedBudget()])
  return !!privateJob&&!!authorizeScorecardSubject(t,privateJob)&&!signal.aborted
}

async function readProjection(raw:Database.Database,id:string):Promise<{projection:Projection;sourceHash:string}|null>{
  const db=sqliteDb(raw)
  const identity=await db.get<{business_name:string|null;website:string|null}>('SELECT business_name,website FROM users WHERE id=?',[id])
  const origin=site(identity?.website)
  if(!safeText(identity?.business_name,180)||!origin)return null
  const competitors=await readCompetitorsStrict(db,id)
  if(!competitors||competitors.length>MAX_COMPETITORS||!competitors.every(s=>safeText(s,60)))return null
  // getMemory has tolerant JSON parsing; independently refuse unreadable or
  // out-of-contract exclusions instead of treating corruption as an empty list.
  const exact=await db.get<{exclusions:string}>('SELECT exclusions FROM tenant_memory WHERE tenant_id=?',[id])
  if(!exact||typeof exact.exclusions!=='string'||exact.exclusions.length>16_384)return null
  const exclusions:unknown=JSON.parse(exact.exclusions)
  const memory=getMemory(raw,id)
  if(!memory||!Array.isArray(exclusions)||exclusions.length>MEMORY_CAPS.exclusions||
    !exclusions.every(v=>safeText(v,MEMORY_CAPS.exclusionLen))||JSON.stringify(memory.exclusions)!==JSON.stringify(exclusions))return null
  return {projection:{businessName:identity.business_name,website:origin,competitors,exclusions},
    sourceHash:digest([identity.business_name,identity.website,competitors,exclusions])}
}

export async function provisionPrivatePolicyContext(primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,reviewed:ScorecardSubjectInput,signal:AbortSignal):Promise<PrivatePolicyContext|null>{
  try{
    if(seeded.has(scratch)||!await current(primary,scratch,execution,reviewed,signal))return null
    const snapshot=await readProjection(primary,execution.ticket.tenantId)
    if(!snapshot||!await current(primary,scratch,execution,reviewed,signal)||seeded.has(scratch))return null
    const p=snapshot.projection
    // Only product-consumed fields. No generic auth migration, users/profile
    // copy, credential columns, identity aliases, or workspace metadata.
    scratch.transaction(()=>{
      scratch.exec('CREATE TABLE users (id TEXT PRIMARY KEY, business_name TEXT NOT NULL, website TEXT NOT NULL)')
      migrateCompetitors(scratch)
      migrateMemory(scratch)
      scratch.prepare('INSERT INTO users(id,business_name,website) VALUES (?,?,?)').run(PRIVATE,p.businessName,p.website)
      const rival=scratch.prepare('INSERT INTO tenant_competitors(tenant_id,name,position) VALUES (?,?,?)')
      for(const [index,name] of p.competitors.entries())rival.run(PRIVATE,name,index)
      scratch.prepare('INSERT INTO tenant_memory(tenant_id,exclusions) VALUES (?,?)').run(PRIVATE,JSON.stringify(p.exclusions))
    }).immediate()
    seeded.add(scratch)
    const context=Object.freeze({}) as PrivatePolicyContext
    contexts.set(context,{primary,scratch,execution,sourceHash:snapshot.sourceHash,projectionHash:digest(p)})
    return await privatePolicyContextCurrent(context,primary,scratch,execution,reviewed,signal)?context:null
  }catch{return null}
}

export async function privatePolicyContextCurrent(context:PrivatePolicyContext,primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,reviewed:ScorecardSubjectInput,signal:AbortSignal):Promise<boolean>{
  const bound=contexts.get(context)
  if(!bound||bound.primary!==primary||bound.scratch!==scratch||bound.execution!==execution)return false
  try{
    if(!await current(primary,scratch,execution,reviewed,signal))return false
    const a=await readProjection(primary,execution.ticket.tenantId)
    const local=await readProjection(scratch,PRIVATE)
    const b=await readProjection(primary,execution.ticket.tenantId)
    return !!a&&!!b&&!!local&&a.sourceHash===bound.sourceHash&&b.sourceHash===bound.sourceHash&&
      digest(local.projection)===bound.projectionHash&&await current(primary,scratch,execution,reviewed,signal)
  }catch{return false}
}
