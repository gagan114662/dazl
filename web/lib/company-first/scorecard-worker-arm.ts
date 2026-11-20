import type { StagingProofRequest, StagingProof } from './scorecard-staging-proof.ts'
// Protected scorecard controller entry. No route, configuration mutation,
// generic case loading, scheduler or public credential input is defined here.
import type Database from 'better-sqlite3'
import { runAdmittedScorecardJob, type Job } from '../scan/runner.ts'
import { accountLimits } from '../llm/spend-pool.ts'
import { runWithScanSpend, scanCapConfig } from '../scan/spend-cap.ts'
import { authorizeScorecardSubject, type ScorecardSubjectInput } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { withNewDiscoveryScratch } from './scorecard-evidence-scratch.ts'
import { runProtectedBaseline, settleMeasuredScorecardArm } from './scorecard-baseline.ts'
import { runProtectedCompanyFirstCandidate, takeSettledStagingCandidateProof, type ProtectedCandidateBindings } from './company-first-protected-candidate.ts'

type PreparedArm = Readonly<{
  release:string; signedToken:string; signingKey:Uint8Array; reviewedInput:ScorecardSubjectInput; mode?:'staging-case-one'
}>
type Result = Readonly<{
  state:'held'; reason:'unauthorized_or_incomplete'|'candidate_unbound'|'scorecard_aborted';
}> | Readonly<{
  state:'measured'; arm:'old'|'new'; caseOrdinal:number; candidates:number; rightPlace:number; proven:number; actualMicros:number; stagingProof?:StagingProof;
}>

export async function runProtectedScorecardScanArm(primary:Database.Database, job:Job, material:PreparedArm,
  bindCandidate:(proof:NonNullable<ReturnType<typeof authorizeScorecardSubject>>,execution:AuthorizedScorecardExecution)=>ProtectedCandidateBindings|null,
  signal:AbortSignal, stagingRequest?:StagingProofRequest):Promise<Result> {
  let outcome:Result = {state:'held',reason:'unauthorized_or_incomplete'}
  if (signal.aborted) return {state:'held',reason:'scorecard_aborted'}
  const actual = await runAdmittedScorecardJob(primary,job,{
    release:material.release,
    async materialFor(scope) {
      if (signal.aborted || scope.tenantId!==job.user_id || scope.jobId!==job.id || scope.attempt!==job.attempts ||
          scope.release!==material.release || scope.lane==='judge') return null
      return {signedToken:material.signedToken,signingKey:material.signingKey, mode:material.mode}
    },
    async runPrivateLane(execution) {
      const ticket=execution.ticket
      if (signal.aborted) return
      if (ticket.lane==='old') {
        const receipt=await runProtectedBaseline(primary,execution,material)
        if (receipt && !signal.aborted) outcome={state:'measured',arm:'old',caseOrdinal:receipt.caseOrdinal,
          candidates:receipt.candidates,rightPlace:receipt.rightPlace,proven:receipt.proven,actualMicros:receipt.actualMicros}
        return
      }
      if (ticket.lane!=='new') return
      const proof=authorizeScorecardSubject(ticket,material.reviewedInput)
      if (!proof) return
      const bindings=bindCandidate(proof,execution)
      if (!bindings) { outcome={state:'held',reason:'candidate_unbound'}; return }
      let measured: Extract<Awaited<ReturnType<typeof runProtectedCompanyFirstCandidate>>,{state:'measured'}>|undefined
      const allowed=await withNewDiscoveryScratch(primary,{tenantId:ticket.tenantId,actorId:ticket.actorId,jobId:ticket.jobId,
        release:ticket.release,attempt:1},material.signedToken,material.signingKey,material.reviewedInput,async workspace=>{
        const result=await runWithScanSpend({
          db:primary,jobId:ticket.jobId,tenantId:ticket.tenantId,attempt:ticket.attempt,cap:scanCapConfig(),
          claudeOnly:true,accountLimits:accountLimits(ticket.tenantId),scorecard:{ticket,lane:'new'},
        },()=>runProtectedCompanyFirstCandidate(execution,bindings,AbortSignal.any([signal,workspace.signal]),workspace.db,stagingRequest))
        if(result.state==='measured')measured=result
      },Date.now,material.mode)
      if (!allowed || !measured || signal.aborted) { outcome={state:'held',reason:'candidate_unbound'}; return }
      const result=measured
      const cost=await settleMeasuredScorecardArm(primary,execution)
      if (cost===null || signal.aborted) return
      const stagingProof=await takeSettledStagingCandidateProof(result,execution,primary,stagingRequest,signal)
      outcome={state:'measured',arm:'new',caseOrdinal:ticket.ordinal,candidates:result.counts.candidates,
        rightPlace:result.counts.rightPlaceSignals,proven:result.counts.proven,actualMicros:cost,
        ...(stagingProof?{stagingProof}:{})}
    },
  })
  if (signal.aborted) return {state:'held',reason:'scorecard_aborted'}
  return actual==='done'||outcome.state==='held' ? Object.freeze(outcome) : {state:'held',reason:'unauthorized_or_incomplete'}
}
