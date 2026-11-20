// One narrow runtime slice: core-issued first-party discovery becomes input
// to existing feedback and literal verification in the protected private flow.
// This is NOT a finish, targeting/ICP pass, currentness proof, or Ready row.
import type Database from 'better-sqlite3'
import { normalizeIcp } from '../scan/icp.ts'
import { feedbackGate, verifyLeads, type LeadDraft, type PageFetcher } from '../scan/runner.ts'
import { readCanonicalAtsPage } from './company-first-canonical-ats-signal.ts'
import { originalCoreAtsSignal, isCoreVerifiedOwnFinding, type Finding, type Scope } from './company-first-evidence.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget, SCORECARD_ANCHOR } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'

type IssuedFinding=Extract<Finding,{state:'signal_verified'}>
type Capture=Readonly<{requestedUrl:string;finalUrl:string;complete:true;page:Exclude<Awaited<ReturnType<PageFetcher>>,null|{fail:unknown}>}>
type Read= (scope:Scope, exactSourceUrl:string, signal:AbortSignal)=>Promise<Capture|null>
const MAX_CANDIDATES=5
const held=Object.freeze({state:'held' as const})
const byteCap=(s:string)=>Buffer.byteLength(s)<=128_000
export async function preverifyCompanyFirstDiscovery(primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution, findings:readonly Finding[], read:Read, signal:AbortSignal) {
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
    return Object.freeze({state:'preverified' as const,attempted:drafts.length,feedbackHeld:feedback.previously_rejected??0,
      literalVerifierPassed:outcome.leads.length,canonicalDated:outcome.leads.filter(r=>r.event_date_proof==="page_bound"||r.event_date_proof==="ats_structured").length,verifierReview:outcome.review.length,verifiedPlace:rightPlace,
      unavailableExactSources:sourceUnavailable.size,canonicalReady:null as null})
  }catch{return held}
}
