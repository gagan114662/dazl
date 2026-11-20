// One narrow runtime slice: core-issued first-party discovery becomes input
// to existing feedback and literal verification in the protected private flow.
// This is NOT a finish, targeting/ICP pass, currentness proof, or Ready row.
import type Database from 'better-sqlite3'
import { normalizeIcp } from '../scan/icp.ts'
import { feedbackGate, verifyLeads, type LeadDraft, type PageFetcher, type VerifyOutcome } from '../scan/runner.ts'
import { readCanonicalAtsPage } from './company-first-canonical-ats-signal.ts'
import { originalCoreAtsSignal, isCoreVerifiedOwnFinding, type Finding, type Scope } from './company-first-evidence.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget, SCORECARD_ANCHOR } from './scorecard-admission.ts'
import { ownsNewDiscoveryScratch } from './scorecard-evidence-scratch.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'

type IssuedFinding=Extract<Finding,{state:'signal_verified'}>
type Capture=Readonly<{requestedUrl:string;finalUrl:string;complete:true;page:Exclude<Awaited<ReturnType<PageFetcher>>,null|{fail:unknown}>}>
type Read= (scope:Scope, exactSourceUrl:string, signal:AbortSignal)=>Promise<Capture|null>
const MAX_CANDIDATES=5
const held=Object.freeze({state:'held' as const})
const byteCap=(s:string)=>Buffer.byteLength(s)<=128_000
type VerifiedDraft = Readonly<VerifyOutcome['leads'][number]>
type QuoteEntries = NonNullable<VerifyOutcome['quotes']> extends Map<string,infer Q> ? Q : never
export type CanonicalDraftFacts = Readonly<{
  quotes:readonly (readonly [string, Readonly<QuoteEntries>])[]
  postingTitles:readonly (readonly [string,string])[]
}>
declare const receiptBrand: unique symbol
export type CanonicalVerifiedDraftReceipt = Readonly<{[receiptBrand]:true}>
const receipts=new WeakMap<CanonicalVerifiedDraftReceipt,{
  scratch:Database.Database; execution:AuthorizedScorecardExecution; finding:IssuedFinding;
  current:()=>boolean; draft:VerifiedDraft; facts:CanonicalDraftFacts
}>()

const factScopes=new WeakMap<CanonicalDraftFacts,Readonly<{
  scratch:Database.Database; execution:AuthorizedScorecardExecution; finding:IssuedFinding
}>>()

export function isCanonicalDraftFactsForScope(facts:CanonicalDraftFacts,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,finding:IssuedFinding):boolean {
  const entry=factScopes.get(facts)
  return !!entry&&scratch.open&&entry.scratch===scratch&&entry.execution===execution&&entry.finding===finding
}

/** Single-use in-process lease. It is not a stage attestation or a grade. */
export function takeCanonicalVerifiedDraft(receipt:CanonicalVerifiedDraftReceipt,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,finding:IssuedFinding):VerifiedDraft|null{
  const entry=receipts.get(receipt)
  if(!entry||entry.scratch!==scratch||entry.execution!==execution||entry.finding!==finding)return null
  receipts.delete(receipt)
  try{return scratch.open&&entry.current()?entry.draft:null}catch{return null}
}

export function readCanonicalVerifiedDraftFacts(receipt:CanonicalVerifiedDraftReceipt,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,finding:IssuedFinding):CanonicalDraftFacts|null {
  const entry=receipts.get(receipt)
  if(!entry||entry.scratch!==scratch||entry.execution!==execution||entry.finding!==finding)return null
  try{return scratch.open&&entry.current()?entry.facts:null}catch{return null}
}

export async function verifySingleCanonicalDraft(primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,finding:IssuedFinding,read:Read,signal:AbortSignal):Promise<CanonicalVerifiedDraftReceipt|null>{
  if(!ownsNewDiscoveryScratch(scratch,primary,execution.ticket))return null
  let receipt:CanonicalVerifiedDraftReceipt|null=null
  await preverifyCompanyFirstDiscovery(primary,scratch,execution,[finding],read,signal,token=>{receipt=token})
  return receipt
}

export function preverifyCompanyFirstDiscovery(primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,findings:readonly Finding[],read:Read,signal:AbortSignal,
  onSingleVerified?: (receipt:CanonicalVerifiedDraftReceipt)=>void){
  const finding=findings[0]
  const canIssue=onSingleVerified&&findings.length===1&&finding?.state==='signal_verified'&&
    ownsNewDiscoveryScratch(scratch,primary,execution.ticket)
  return preverify(primary,scratch,execution,findings,read,signal,canIssue?(draft,current,facts)=>{
    const receipt=Object.freeze({}) as CanonicalVerifiedDraftReceipt
    receipts.set(receipt,{scratch,execution,finding,current,draft:Object.freeze(structuredClone(draft)),facts})
    factScopes.set(facts,{scratch,execution,finding})
    onSingleVerified(receipt)
  }:undefined)
}

async function preverify(primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution, findings:readonly Finding[], read:Read, signal:AbortSignal,
  issue?: (draft:VerifiedDraft,current:()=>boolean,facts:CanonicalDraftFacts)=>void) {
  const x=execution.ticket
  if(x.lane!=='new'||execution.vendor!=='anthropic'||execution.funding!=='workspace_owned'||signal.aborted||
    primary===scratch||!scratch.memory||x.attempt!==1||findings.length>20)return held
  const scope=Object.freeze({tenant:x.tenantId,job:x.jobId,attempt:String(x.attempt)})
  try{
    // Unlike dispatch preflight, this later phase requires completed—not absent—
    // canonical discovery reservations. It is strictly read-only.
    const current=()=>!signal.aborted&&Date.now()<x.expiresAt&&!!primary.prepare(`
      SELECT 1 FROM scan_jobs j JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce
      JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=c.tenant_id
      JOIN organizations o ON o.id=p.tenant_id JOIN memberships m ON m.tenant_id=o.id AND m.member_id=p.actor_id AND m.role='owner'
      WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.status='running' AND j.error IS NULL
        AND j.company_scorecard_dispatch_release=? AND j.company_scorecard_dispatch_started_at IS NOT NULL
        AND j.business_name=? AND j.query IS NULL AND j.icp IS NULL AND j.run_budget=?
        AND c.job_id=j.id AND c.tenant_id=j.user_id AND c.attempt=j.attempts AND c.status='running' AND c.lane=1
        AND c.nonce=? AND c.ordinal=? AND c.expires_at=? AND c.subject_mac=? AND p.cohort=? AND p.next_ordinal=c.ordinal
        AND p.release=? AND p.actor_id=? AND p.workspace_revision=? AND p.roster=?
        AND o.company_first_scorecard_enabled=1 AND o.company_first_scorecard_revision=p.workspace_revision
        AND NOT EXISTS(SELECT 1 FROM tenant_tombstones d WHERE d.deleted_tenant IN(o.id,m.member_id))
        AND EXISTS(SELECT 1 FROM scan_spend_calls s WHERE s.user_id=j.user_id AND s.scan_job_id=j.id AND s.status='settled')
        AND NOT EXISTS(SELECT 1 FROM scan_spend_calls s WHERE s.user_id=j.user_id AND s.scan_job_id=j.id AND s.status<>'refused' AND
          (s.attempt<>j.attempts OR s.kind<>'llm.anthropic.web_search' OR s.status<>'settled' OR s.settled_at IS NULL
            OR s.actual_usd IS NULL OR s.actual_usd<0 OR s.actual_usd>s.reserve_usd OR NOT EXISTS(
              SELECT 1 FROM company_scorecard_calls b WHERE b.reservation_id=s.id AND b.tenant_id=s.user_id AND b.nonce=c.nonce AND b.lane=1)))`)
       .get(x.jobId,x.tenantId,x.attempt,x.release,SCORECARD_ANCHOR.business_name,scorecardPinnedBudget(),x.nonce,x.ordinal,x.expiresAt,
        x.subjectMac,x.cohort,x.release,x.actorId,x.workspaceRevision,JSON.stringify(x.presets))
    if(!current())return held
    const dbs=scratch.pragma('database_list') as {name:string;file:string}[]
    if(dbs.some(r=>r.file||(r.name!=='main'&&r.name!=='temp')))return held
    const privateJob=scratch.prepare(`SELECT query,icp,offer,seller,sources,run_budget FROM scan_jobs
       WHERE id=? AND user_id='private-scratch' AND attempts=? AND status='running' AND error IS NULL`).get(x.jobId,x.attempt) as
       {query:string;icp:string;offer:string|null;seller:string|null;sources:string|null;run_budget:string|null}|undefined
    if(!privateJob||privateJob.run_budget!==scorecardPinnedBudget()||!authorizeScorecardSubject(x,privateJob))return held
    const geo=normalizeIcp(JSON.parse(privateJob.icp))?.where??[]
    if(!geo.length)return held
    const originals:IssuedFinding[]=findings.filter((f):f is IssuedFinding=>f.state==='signal_verified')
    const ats=new Map(originals.map(f=>[f.signal.sourceUrl,originalCoreAtsSignal(f,scope)]))
    if(originals.length>MAX_CANDIDATES||originals.some(f=>!isCoreVerifiedOwnFinding(f,scope)&&!ats.get(f.signal.sourceUrl)))return held
    const byUrl=new Map(originals.map(f=>[f.signal.sourceUrl,f]))
    if(byUrl.size!==originals.length)return held
    const drafts:LeadDraft[]=originals.map(f=>({
      company:f.name, name:'', contact:null, source_url:f.signal.sourceUrl, excerpt:f.signal.quote,
      signal:ats.get(f.signal.sourceUrl)?'Hiring for an open posting':f.signal.quote,score:0,event_date:f.signal.date,
      // Existing verifier must rediscover page date proof; do not set proof from new-finder status.
    }))
    const feedback:Record<string,number>={}
    const eligible=await feedbackGate(primary,x.tenantId).apply(drafts,feedback,()=>{})
    if(feedback.feedback_unreadable||!current())return held
    let rightPlace=0
    const sourceUnavailable=new Set<string>()
    const outcome=await verifyLeads(eligible,async u=>{
      if(!byUrl.has(u)||!current())return null
      const atsSignal=ats.get(u)
      if(atsSignal){
        const page=await readCanonicalAtsPage(atsSignal,scope,u,signal)
        if(!current())return null
        if(!page){sourceUnavailable.add(u);return null}
        return page
      }
      const got=await read(scope,u,signal)
      if(!current())return null
      if(!got||got.complete!==true||got.finalUrl!==u||got.requestedUrl!==u||!byteCap(got.page.text)||!byteCap(got.page.title)) {
        sourceUnavailable.add(u);return null
      }
      // Reject third-party board claims and mutable transport fields in this first-party subset.
      return {text:got.page.text,title:got.page.title,retrievedAt:got.page.retrievedAt}
    },new Date(),undefined,null,undefined,undefined,geo,undefined,()=>{rightPlace++})
    if(!current())return held
    if(issue&&originals.length===1&&rightPlace===1&&outcome.leads.length===1){
      const f=originals[0],d=outcome.leads[0]
      if(d.company===f.name&&d.source_url===f.signal.sourceUrl&&d.excerpt===f.signal.quote&&d.event_date===f.signal.date&&
         (d.event_date_proof==='page_bound'||d.event_date_proof==='ats_structured')){
        const quotes=[...(outcome.quotes??new Map<string,QuoteEntries>())].map(([k,qs])=>
          Object.freeze([k,Object.freeze(qs.map(q=>Object.freeze({...q})))] as const))
        const postingTitles=[...(outcome.postingTitles??new Map<string,string>())].map(([k,title])=>Object.freeze([k,title] as const))
        issue(d,current,Object.freeze({quotes:Object.freeze(quotes),postingTitles:Object.freeze(postingTitles)}))
      }
    }
    return Object.freeze({state:'preverified' as const,attempted:drafts.length,feedbackHeld:feedback.previously_rejected??0,
      literalVerifierPassed:outcome.leads.length,canonicalDated:outcome.leads.filter(r=>r.event_date_proof==="page_bound"||r.event_date_proof==="ats_structured").length,verifierReview:outcome.review.length,verifiedPlace:rightPlace,
      unavailableExactSources:sourceUnavailable.size,canonicalReady:null as null})
  }catch{return held}
}
