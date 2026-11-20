// Internal staging-only evidence. No route, print, persistence, signer, or
// environment provisioning. The distinct operator signing key is not the
// scorecard admission key. Scope is bound to the opaque reviewed case, not
// merely its roster index.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'
import type { VerifiedScorecardTicket } from './scorecard-admission.ts'

export type StagingProofRequest = Readonly<{ expiresAt:number; mac:string }>
export type StagingReadySample = Readonly<{ company:string; website:string; buyer:string }>
export type StagingProof = Readonly<{ held:number; samples:readonly StagingReadySample[] }>

export function allowStagingProof(ticket:VerifiedScorecardTicket, request:StagingProofRequest|undefined,
  now=Date.now(), env=process.env):boolean {
  const key=env.DAZL_STAGING_SCORECARD_PROOF_KEY
  if(env.DAZL_ENV!=='staging'||env.DAZL_COMMIT_SHA!==ticket.release||ticket.lane!=='new'||
    !key||!/^[a-f0-9]{64}$/.test(key)||!request||!/^[a-f0-9]{64}$/.test(request.mac)||
    !Number.isSafeInteger(request.expiresAt)||request.expiresAt<=now||request.expiresAt>ticket.expiresAt||
    request.expiresAt-now>15*60_000) return false
  const message=JSON.stringify(['dazl-staging-scorecard-proof/v1',ticket.tenantId,ticket.actorId,ticket.jobId,ticket.attempt,
    ticket.release,ticket.workspaceRevision,ticket.cohort,ticket.ordinal,ticket.nonce,ticket.subjectMac,request.expiresAt])
  return timingSafeEqual(Buffer.from(request.mac,'hex'),createHmac('sha256',Buffer.from(key,'hex')).update(message).digest())
}

export function projectStagingSample(company:string,website:string,buyer:string):StagingReadySample|null {
  // All inputs must originate from an exact canonical Ready object. Treat any
  // email-like or control-bearing label as unfit even when the source asserts it.
  const label=(value:string)=>typeof value==='string'&&value.length>0&&value.length<=180&&
    !/[@\p{Cc}\p{Cf}]/u.test(value)&&value.trim()===value
  if(!label(company)||!label(buyer))return null
  try {
    const url=new URL(website)
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/')return null
    return Object.freeze({company,website:url.origin,buyer})
  } catch{return null}
}


// This helper exposes only a Boolean, never proof. The candidate-local WeakMap
// additionally requires the actual measured result and original execution ticket.
export async function hasSettledStagingProofAuthority(db:Db,t:VerifiedScorecardTicket,
  request:StagingProofRequest|undefined,signal:AbortSignal):Promise<boolean> {
  if(signal.aborted||!allowStagingProof(t,request)) return false
  try{
    const permitted = await db.tx(function* (tx){
      if(signal.aborted||!allowStagingProof(t,request)||!(yield* requireScorecardWorkspace(tx,t)))return false
      const row=yield* tx.get(`SELECT 1 FROM scan_jobs j
        JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce AND c.job_id=j.id AND c.attempt=j.attempts
        JOIN company_scorecard_cohorts p ON p.cohort=c.cohort
        WHERE j.id=? AND j.user_id=? AND j.attempts=? AND j.company_scorecard_dispatch_release=?
          AND j.company_scorecard_dispatch_started_at IS NOT NULL AND j.status='done' AND j.error IS NULL
          AND c.nonce=? AND c.status='complete' AND c.lane=1 AND c.tenant_id=j.user_id AND c.subject_mac=?
          AND c.cohort=? AND c.ordinal=? AND c.expires_at=? AND p.tenant_id=j.user_id
          AND p.actor_id=? AND p.release=? AND p.workspace_revision=?
          AND EXISTS (SELECT 1 FROM scan_spend_calls s JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
            WHERE b.nonce=c.nonce AND b.lane=c.lane AND s.scan_job_id=j.id AND s.user_id=j.user_id AND s.attempt=j.attempts
              AND s.status='settled' AND s.actual_usd IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM scan_spend_calls s WHERE s.scan_job_id=j.id AND s.user_id=j.user_id AND s.status='reserved')`,
        [t.jobId,t.tenantId,t.attempt,t.release,t.nonce,t.subjectMac,t.cohort,t.ordinal,t.expiresAt,t.actorId,t.release,t.workspaceRevision])
      return !!row
    })
    return !!permitted&&!signal.aborted&&allowStagingProof(t,request)
  }catch{return false}
}
