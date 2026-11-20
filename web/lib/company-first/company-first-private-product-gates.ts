// Private observation only. These are the same product checks, not a synthetic
// StageAttestation writer, a Ready receipt, or permission to publish/send.
import type Database from 'better-sqlite3'
import { asDb } from '../db/client.ts'
import { feedbackGate } from '../scan/runner.ts'
import { migrateNeedEvidence, recordNeedEvidence } from '../scan/need-evidence.ts'
import { loadPlayDemandRubric } from '../scan/demand-rubric-play.ts'
import { applySalesHiringGate, type QuoteEvidence } from '../scan/sales-hiring-gate.ts'
import { classifyLeads, recordActionability } from '../scan/actionable.ts'
import { recordTimingProof, timingProofGap } from '../scan/timing-proof.ts'
import { applyRejections } from '../scan/feedback.ts'
import { parseIcp } from '../scan/icp.ts'
import { currentSiteContact, whoOf } from '../scan/site-contact.ts'
import { ownsNewDiscoveryScratch } from './scorecard-evidence-scratch.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget, SCORECARD_ANCHOR, type ScorecardSubjectInput } from './scorecard-admission.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'
import { isCoreVerifiedAtsFinding, isCoreVerifiedOwnFinding, type Finding } from './company-first-evidence.ts'
import { isCanonicalDraftFactsForScope, type CanonicalDraftFacts } from './company-first-canonical-discovery.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'

type IssuedFinding=Extract<Finding,{state:'signal_verified'}>
export type StagedPrivateFinding=Readonly<{id:string;finding:IssuedFinding;facts?:CanonicalDraftFacts}>
type Job = Readonly<{id:string;user_id:string;attempts:number;query:string;icp:string|null;sources:string|null;seller:string|null;offer:string|null}>
type Lead = Readonly<{id:string;company:string;company_domain:string|null;source_url:string;evidence_excerpt:string;event_date:string;event_date_proof:string;
  name:string;contact:string|null;review_reason:string|null;quarantined_at:number|null;confidence:number|null}>
type Observation = Readonly<{state:'held'; reason:'authority_unavailable'|'source_binding_unavailable'|'feedback_held'|'stage_unavailable'}> |
  Readonly<{state:'checked'; admitted:number; salesProofHeld:number; rubricAvailable:boolean; actionable:number; timingProven:number; held:number; qualifiedIds:readonly string[]}>

// Deliberately no production transport, board retry, renderer, or inferred
// title. If the already-bound own stored quote does not meet the real rule,
// a board-dependent case must hold, not go back out to a publisher.
const noTransport:typeof fetch=async()=>{throw new Error('private_gate_transport_disabled')}

export async function runPrivateCompanyFirstProductGates(primary:Database.Database,scratch:Database.Database,
  execution:AuthorizedScorecardExecution,reviewed:ScorecardSubjectInput,staged:readonly StagedPrivateFinding[],
  signal:AbortSignal):Promise<Observation>{
  const ticket=execution.ticket
  const held=(reason:Extract<Observation,{state:'held'}>['reason']):Observation=>({state:'held',reason})
  const authorized=()=>asDb(primary).tx(function* (tx){
    if(!(yield* requireScorecardWorkspace(tx,ticket)))return false
    const row=yield* tx.get(`SELECT 1 FROM scan_jobs j
      JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce AND c.job_id=j.id AND c.tenant_id=j.user_id AND c.attempt=j.attempts
      JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=j.user_id AND p.next_ordinal=c.ordinal
      WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.status='running' AND j.error IS NULL AND j.funded_by='user'
        AND j.company_scorecard_dispatch_release=? AND j.company_scorecard_dispatch_started_at IS NOT NULL AND j.business_name=? AND j.run_budget=?
        AND j.query IS NULL AND j.icp IS NULL AND j.sources IS NULL AND j.seller IS NULL AND j.offer IS NULL AND j.icp_inferred IS NULL
        AND c.nonce=? AND c.subject_mac=? AND c.status='running' AND c.lane=1 AND c.ordinal=? AND c.cohort=? AND c.expires_at=?
        AND p.release=? AND p.actor_id=? AND p.workspace_revision=? AND p.roster=?
        AND EXISTS (SELECT 1 FROM scan_spend_calls s JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
          WHERE s.scan_job_id=j.id AND s.user_id=j.user_id AND s.attempt=j.attempts AND s.status='settled'
            AND s.settled_at IS NOT NULL AND s.actual_usd IS NOT NULL AND b.nonce=c.nonce AND b.lane=c.lane)
        AND NOT EXISTS (SELECT 1 FROM scan_spend_calls s LEFT JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
          WHERE s.scan_job_id=j.id AND s.user_id=j.user_id AND s.status<>'refused' AND
          (s.attempt<>j.attempts OR s.status<>'settled' OR s.settled_at IS NULL OR s.actual_usd IS NULL OR
            s.actual_usd<0 OR s.actual_usd>s.reserve_usd OR b.nonce IS NULL OR b.nonce<>c.nonce OR b.lane<>c.lane))`,
      [ticket.jobId,ticket.tenantId,ticket.attempt,ticket.release,SCORECARD_ANCHOR.business_name,scorecardPinnedBudget(),
        ticket.nonce,ticket.subjectMac,ticket.ordinal,ticket.cohort,ticket.expiresAt,ticket.release,ticket.actorId,ticket.workspaceRevision,JSON.stringify(ticket.presets)])
    return !!row
  })
  const current=async()=> !signal.aborted&&process.env.DAZL_ENV==='staging'&&process.env.DAZL_COMMIT_SHA===ticket.release&&
    scratch!==primary&&scratch.memory&&ownsNewDiscoveryScratch(scratch,primary,ticket)&&
    !!authorizeScorecardSubject(ticket,reviewed)&&await authorized()&&!signal.aborted
  try{
    if(!await current())return held('authority_unavailable')
    if(staged.length<1||staged.length>5||new Set(staged.map(s=>s.id)).size!==staged.length||
      staged.some(s=>!/^[a-f0-9]{24}$/.test(s.id)))return held('source_binding_unavailable')
    const scope={tenant:ticket.tenantId,job:ticket.jobId,attempt:String(ticket.attempt)}
    const db=asDb(scratch)
    const readJob=()=>db.get<Job>(`SELECT id,user_id,attempts,query,icp,sources,seller,offer FROM scan_jobs
      WHERE id=? AND user_id='private-scratch' AND attempts=? AND status IN ('running','done') AND error IS NULL
      AND funded_by='user' AND csv_domain IS NULL AND watch_id IS NULL AND run_budget=?`,[ticket.jobId,ticket.attempt,scorecardPinnedBudget()])
    const readRows=()=>db.all<Lead>(`SELECT id,company,company_domain,source_url,evidence_excerpt,event_date,event_date_proof,name,contact,
      review_reason,quarantined_at,confidence FROM leads WHERE scan_job_id=?`,[ticket.jobId])
    const job=await readJob(), rows=await readRows()
    if(!job||!authorizeScorecardSubject(ticket,job))return held('authority_unavailable')
    if(rows.length!==staged.length||rows.some(row=>{
      const finding=staged.find(s=>s.id===row.id)?.finding
      return !finding||row.review_reason!==null||row.quarantined_at!==null||row.confidence===null||
        finding.name!==row.company||finding.signal.sourceUrl!==row.source_url||
        finding.signal.date!==row.event_date||finding.signal.quote!==row.evidence_excerpt||
        !(row.event_date_proof==='page_bound'&&isCoreVerifiedOwnFinding(finding,scope)||
          row.event_date_proof==='ats_structured'&&isCoreVerifiedAtsFinding(finding,scope))
    }))return held('source_binding_unavailable')
    const feedbackPass=async()=>{
      const rejections=await feedbackGate(primary,ticket.tenantId).rejections()
      if(!rejections)return false
      const result=applyRejections(rows.map(row=>{
        const stored=currentSiteContact(scratch,job.user_id,row,whoOf(job.icp)||'founder')
        const contactName=stored.person?.value.split(',')[0]?.trim()
        return {...row,name:contactName||row.name}
      }),rejections)
      return result.dropped.length===0&&result.stripped.length===0
    }
    if(!await feedbackPass())return held('feedback_held')
    if(!await current())return held('authority_unavailable')
    const at=new Date()
    const quotes=new Map<string,QuoteEvidence[]>(),postingTitles=new Map<string,string>()
    for (const row of staged) {
      if(!row.facts)continue
      if(!isCanonicalDraftFactsForScope(row.facts,scratch,execution,row.finding))return held('source_binding_unavailable')
      for(const [k,items] of row.facts.quotes)quotes.set(k,[...(quotes.get(k)??[]),...items])
      for(const [k,title] of row.facts.postingTitles) {
        if(postingTitles.has(k)&&postingTitles.get(k)!==title)return held('source_binding_unavailable')
        postingTitles.set(k,title)
      }
    }
    const sales=await applySalesHiringGate(scratch,job,noTransport,{now:at.getTime(),quotes,postingTitles})
    if(!await current())return held('authority_unavailable')
    migrateNeedEvidence(scratch)
    const window=(job.icp?parseIcp(job.icp)?.window_days:null)??undefined
    // Scratch intentionally has no primary users/competitors copied. The
    // canonical loader reports an unavailable rubric rather than assuming an
    // empty exclusion list. No author/demand artifacts are invented.
    const {rubric}=await loadPlayDemandRubric(db,job.user_id,job.id,window)
    await recordNeedEvidence(db,job.user_id,job.id,{asOf:at,windowDays:window})
    if(!await current()||!await readJob())return held('authority_unavailable')
    const need={rubric}
    const classified=classifyLeads(scratch,job,new Map(),need)
    recordActionability(scratch,job,new Map(),need)
    recordTimingProof(scratch,job,at)
    const qualifiedIds=Object.freeze(classified.filter(row=>row.actionable&&timingProofGap(scratch,job.user_id,row.lead_id,at)===null)
      .map(row=>row.lead_id))
    const timingProven=qualifiedIds.length
    if(!await current()||!await feedbackPass()||!await current())return held('authority_unavailable')
    return Object.freeze({state:'checked',admitted:rows.length,salesProofHeld:sales.demoted,
      rubricAvailable:rubric!==null,actionable:classified.filter(r=>r.actionable).length,timingProven,held:rows.length-timingProven,qualifiedIds})
  }catch{return held('stage_unavailable')}
}
