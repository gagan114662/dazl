// Static staging-only adapter. The signed plan configures approved criteria;
// route/browser input cannot install ports, bypass holds, or start this path.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { sqliteDb } from '../db/client.ts'
import { feedbackVersion } from '../scan/feedback.ts'
import { bindGuardedCompanyFirstContact } from './company-first-guarded-contact.ts'
import { stageCanonicalSiteContact } from './company-first-canonical-contact-store.ts'
import { type CandidateKey, type Claim, type ProofSnapshot, type StageAttestation, proofBinding, STRICT_GATE_STAGE } from './company-first-private-proof.ts'
import { currentCanonicalContactPacket } from './company-first-final-proof-adapter.ts'
import { runPrivateCompanyFirstProductGates } from './company-first-private-product-gates.ts'
import { provisionPrivatePolicyContext, privatePolicyContextCurrent, type PrivatePolicyContext } from './company-first-private-policy-context.ts'
import { authorizeScorecardSubject, isStagingCaseOneTicket } from './scorecard-admission.ts'
import { bindReviewedDiscoveryReads } from './scorecard-discovery-read-bindings.ts'
import { bindReviewedCompanyPlan } from './scorecard-reviewed-company-plan.ts'
import type { StagingCaseOneBinder } from './scorecard-staging-case-one-entry.ts'
import type { CanonicalRead, ProtectedCandidateBindings } from './company-first-protected-candidate.ts'

const sha=(data:unknown)=>createHash('sha256').update(JSON.stringify(data)).digest('hex')
const fold=(s:string)=>s.normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase()
const scopeMatches=(a:Claim,b:Claim)=>a.tenant===b.tenant&&a.job===b.job&&a.actor===b.actor&&a.attempt===b.attempt

export const prepareStagingCaseOneBinding:StagingCaseOneBinder=async (primary,scope)=>{
  if(process.env.DAZL_ENV!=='staging'||process.env.DAZL_COMMIT_SHA!==scope.release||scope.lane!=='new'||!primary.open)return null
  return (proof,execution):ProtectedCandidateBindings|null=>{
    const ticket=execution.ticket
    if(!isStagingCaseOneTicket(ticket)||ticket.release!==scope.release||ticket.tenantId!==scope.tenantId||ticket.actorId!==scope.actorId||
      ticket.jobId!==scope.jobId||!authorizeScorecardSubject(ticket,proof.subject))return null
    const life=AbortSignal.timeout(Math.max(1,Math.min(8*60_000,ticket.expiresAt-Date.now())))
    const plan=bindReviewedCompanyPlan(proof,execution,life)
    // The case-one pilot does not yet install a reviewed second size issuer.
    // Refuse a hard-size case before discovery, rather than pay for a path
    // that can never pass or remove an approved size constraint.
    if(!plan||plan.requiresSizeProof)return null
    const db=sqliteDb(primary), reads=bindReviewedDiscoveryReads(db,proof,execution,plan.publicReads)
    if(!reads)return null
    const exactScope=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,attempt:String(ticket.attempt)})
    const claim=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,actor:ticket.actorId,attempt:ticket.attempt})
    const contact=bindGuardedCompanyFirstContact(exactScope,{
      publicRead:reads.publicRead,
      isCurrent:async s=>reads.publicRead.isCurrent(s),
      reserveBeforeDispatch:async r=>!r.signal.aborted&&await reads.publicRead.isCurrent(r.scope),
    })
    const plans=plan.publicReads
    const titles=new Set(plans.literalTitles.map(fold)), places=new Set(plans.literalOnsitePlaces.map(fold))
    const snapshots=new Map<string,{receipt:ProofSnapshot;rowHash:string}>()
    let installedPolicy:PrivatePolicyContext|null=null, writtenScratch:Database.Database|null=null, feedback:number|null=null, finalLedger:string|null=null
    let used=false
    const ledger=()=>{
      const rows=primary.prepare(`SELECT s.id,s.status,s.kind,s.settled_at,s.actual_usd,s.reserve_usd,b.nonce,b.lane
        FROM scan_spend_calls s LEFT JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
        WHERE s.scan_job_id=? AND s.user_id=? AND s.attempt=? AND s.status<>'refused' ORDER BY s.id`).all(ticket.jobId,ticket.tenantId,ticket.attempt) as
        {id:string;status:string;kind:string;settled_at:number|null;actual_usd:number|null;reserve_usd:number;nonce:string;lane:number}[]
      return rows.length&&rows.every(r=>r.nonce===ticket.nonce&&r.lane===1&&r.status==='settled'&&r.settled_at!==null&&
        (r.kind==='llm.anthropic'||r.kind==='llm.anthropic.web_search')&&r.actual_usd!==null&&r.actual_usd>=0&&r.actual_usd<=r.reserve_usd)?sha(rows):null
    }
    const rowHash=(scratch:Database.Database,id:string):string|null=>{
      const lead=scratch.prepare('SELECT * FROM leads WHERE id=? AND scan_job_id=?').get(id,ticket.jobId)
      if(!lead)return null
      const rows=scratch.prepare("SELECT * FROM lead_enrichments WHERE lead_id=? AND tenant_id='private-scratch' ORDER BY id").all(id)
      const need=scratch.prepare("SELECT * FROM lead_need_evidence WHERE lead_id=? AND tenant_id='private-scratch'").get(id)
      return sha([lead,rows,need])
    }
    const currentPolicy=async(signal:AbortSignal)=>{
      try{return !signal.aborted&&!life.aborted&&!!installedPolicy&&!!writtenScratch&&feedback!==null&&!!finalLedger&&ledger()===finalLedger&&
        await feedbackVersion(db,ticket.tenantId)===feedback&&
        await privatePolicyContextCurrent(installedPolicy,primary,writtenScratch,execution,proof.subject,signal)&&ledger()===finalLedger}
      catch{return false}
    }
    const canonical:CanonicalRead={
      readCurrentProtectedSession:reads.reciprocalOwner.readCurrentAuthorizedSource,
      reviewedSubject:proof.subject,
      currentCompletedPolicy:currentPolicy,
      async prepareScratch(input){
        if(input.primary!==primary||input.execution!==execution||installedPolicy||input.signal.aborted||life.aborted)return false
        writtenScratch=input.scratch
        installedPolicy=await provisionPrivatePolicyContext(primary,input.scratch,execution,proof.subject,input.signal)
        return !!installedPolicy&&!input.signal.aborted
      },
      readStages(scratch,asked,key){
        const row=snapshots.get(key.id)
        return scratch===writtenScratch&&scopeMatches(claim,asked)&&row?.receipt.candidate.key.revision===key.revision&&
          rowHash(scratch,key.id)===row.rowHash&&ledger()===finalLedger?row.receipt:null
      },
      async finishStagedCandidates(input){
        const {scratch,signal,candidates}=input
        if(used||signal.aborted||life.aborted||input.primary!==primary||input.execution!==execution||!candidates.length||candidates.length>5)return null
        used=true
        if(!installedPolicy||writtenScratch!==scratch)return null
        feedback=await feedbackVersion(db,ticket.tenantId)
        finalLedger=ledger()
        if(!await currentPolicy(signal))return null
        const contacts=new Map<string,NonNullable<ReturnType<typeof currentCanonicalContactPacket>>>()
        for(const candidate of candidates){
          const s=Object.freeze({primary,scratch,execution,finding:candidate.finding,signal})
          const observed=stageCanonicalSiteContact(candidate.packet,s,candidate.site,{homepage:candidate.homepage})
          const binding=currentCanonicalContactPacket(candidate.packet,s)
          if(observed?.currentRoute&&binding?.id===candidate.id)contacts.set(candidate.id,binding)
        }
        const gates=await runPrivateCompanyFirstProductGates(primary,scratch,execution,proof.subject,candidates,signal)
        if(gates.state!=='checked'||!gates.rubricAvailable||!await currentPolicy(signal))return null
        const approved=candidates.filter(c=>gates.qualifiedIds.includes(c.id)&&contacts.has(c.id))
        const finished=scratch.transaction(()=>{
          const result=scratch.prepare(`UPDATE scan_jobs SET status='done',finished_at=?,claimed_at=NULL,candidates=?,verified=?
            WHERE id=? AND user_id='private-scratch' AND status='running' AND error IS NULL AND attempts=?`)
            .run(Math.floor(Date.now()/1000),candidates.length,approved.length,ticket.jobId,ticket.attempt)
          return result.changes===1
        }).immediate()
        if(!finished||!await currentPolicy(signal))return null
        const keys=new Map<string,CandidateKey>(), checked=Date.now()
        const policyRevision=sha([ticket.workspaceRevision,feedback,ticket.subjectMac])
        const expiresAt=Math.min(ticket.expiresAt,checked+60_000)
        for(const item of approved){
          const bound=contacts.get(item.id)
          const row=rowHash(scratch,item.id)
          if(!bound||!row)return null
          const key=Object.freeze({id:item.id,revision:row})
          const binding=proofBinding(claim,key,policyRevision,bound.evidence)
          const stages=Object.entries(STRICT_GATE_STAGE) as [StageAttestation['gate'],StageAttestation['stage']][]
          const currentInputs=Object.fromEntries(stages.map(([gate])=>[gate,sha([gate,row,policyRevision,finalLedger])])) as ProofSnapshot['currentInputs']
          // Exact gates above have all run: canonical date/role/site,
          // budgeted grading and buyer fit, feedback, existing sales/target,
          // the canonical need rule, timing, and the published-contact reads.
          const attestations=stages.map(([gate,stage])=>Object.freeze({
            gate,stage,binding,inputRevision:currentInputs[gate],checkedAt:checked,expiresAt,decision:'passed' as const,
          }) as StageAttestation)
          const receipt:ProofSnapshot=Object.freeze({claim,authorization:'current',phase:'finalized',
            settlement:Object.freeze({attempt:ticket.attempt,state:'all_charges_resolved',revision:finalLedger!}),policyRevision,
            candidate:Object.freeze({key,evidence:bound.evidence}),currentInputs:Object.freeze(currentInputs),attestations:Object.freeze(attestations)})
          keys.set(item.id,key)
          snapshots.set(item.id,{receipt,rowHash:row})
        }
        return keys
      },
    }
    const bindings:ProtectedCandidateBindings={
      readReviewedPublicDiscovery:plan.readReviewedPublicDiscovery,
      publicRead:reads.publicRead,reciprocalOwner:reads.reciprocalOwner,canonicalAts:reads.canonicalAts,
      // Unreviewed source classes have no fallback authority in this pilot.
      verifyDatedSignal:async()=>null,
      canonicalCareer:{matchesRole:title=>titles.has(fold(title)),
        matchesPlace:(key,place)=>key===plans.placeKey&&[place.locality,place.region,place.country].every(v=>v.trim())&&
          places.has(fold([place.locality,place.region,place.country].join(', ')))},
      contact,canonical,
    }
    return Object.freeze(bindings)
  }
}
