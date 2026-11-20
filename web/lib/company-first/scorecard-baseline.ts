// Protected composer only. Never import this into an ordinary scan route.
// The actual legacy verifier only sees in-memory evidence storage; the
// independent current account and spend ledger remain canonical in primary.
import type Database from 'better-sqlite3'
import { sqliteDb } from '../db/client.ts'
import { runAuthorizedLegacyInMemory } from '../scan/runner.ts'
import { completeScorecardBillingTx, type ScorecardSubjectInput } from './scorecard-admission.ts'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { withCanonicalEvidenceScratch } from './scorecard-evidence-scratch.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'

export type ProtectedBaselineMetrics = Readonly<{
  caseOrdinal: number; arm: 'old'; candidates: number; rightPlace: number; proven: number;
  actualMicros: number; seal: string
}>
type Material = Readonly<{ signedToken: string; signingKey: Uint8Array; reviewedInput: ScorecardSubjectInput }>

export async function runProtectedBaseline(
  primary: Database.Database, execution: AuthorizedScorecardExecution, material: Material,
): Promise<ProtectedBaselineMetrics | null> {
  const ticket = execution.ticket
  if (ticket.lane !== 'old' || ticket.attempt !== 1) return null
  try {
    const receipt = await withCanonicalEvidenceScratch(
      primary, { tenantId:ticket.tenantId, actorId:ticket.actorId, jobId:ticket.jobId, attempt:1, release:ticket.release },
      material.signedToken, material.signingKey, material.reviewedInput,
      async ({ db, job, signal }) => {
        if (signal.aborted || await runAuthorizedLegacyInMemory(primary,db,job,execution) !== 'done' || signal.aborted)
          throw new Error('private_baseline_not_complete')
      },
    )
    if (receipt?.schema !== 'private-canonical-scratch-v1' || typeof receipt.candidateCount !== 'number' ||
        typeof receipt.rightPlaceCount !== 'number') return null
    const { candidateCount, rightPlaceCount, seal } = receipt
    const proven = receipt.candidates.filter(c => c.canonicalReady && c.ownedSource && c.namedBuyer && c.publishedWorkEmail).length
    if (!Number.isSafeInteger(candidateCount) || !Number.isSafeInteger(rightPlaceCount) ||
        rightPlaceCount > candidateCount || proven > candidateCount) return null
    const actualMicros = await settleMeasuredScorecardArm(primary,execution)
    if (actualMicros===null) return null
    return Object.freeze({ caseOrdinal:ticket.ordinal,arm:'old',candidates:candidateCount,rightPlace:rightPlaceCount,proven,actualMicros,seal })
  } catch { return null }
}

// Internal accounting only. Caller must hold a genuine measured receipt. This
// does not diagnose lead quality or issue an evidence seal.
export async function settleMeasuredScorecardArm(primary:Database.Database, execution:AuthorizedScorecardExecution):Promise<number|null> {
  const ticket=execution.ticket
  try {
    return await sqliteDb(primary).tx(function* (t) {
      if (!(yield* requireScorecardWorkspace(t,ticket)) || Date.now() >= ticket.expiresAt)
        throw new Error('private_baseline_not_complete')
      const now = Math.floor(Date.now()/1000)
      const sealed = yield* t.run(`UPDATE scan_jobs SET status='done',finished_at=?,claimed_at=NULL
        WHERE id=? AND user_id=? AND attempts=? AND error IS NULL AND status='running'
           AND company_scorecard_claim_nonce=? AND company_scorecard_dispatch_release=?
           AND company_scorecard_dispatch_started_at IS NOT NULL`,
        [now,ticket.jobId,ticket.tenantId,ticket.attempt,ticket.nonce,ticket.release])
      if (sealed.changes !== 1 || !(yield* completeScorecardBillingTx(t,ticket,requireScorecardWorkspace)))
        throw new Error('private_baseline_not_complete')
      const charges = yield* t.all<{actual:number}>(`SELECT s.actual_usd AS actual FROM scan_spend_calls s
        JOIN company_scorecard_calls b ON b.reservation_id=s.id AND b.tenant_id=s.user_id
        WHERE b.nonce=? AND b.lane=? AND s.scan_job_id=? AND s.user_id=? AND s.attempt=? AND s.status='settled'`,
        [ticket.nonce,(['old','new','judge'] as const).indexOf(ticket.lane),ticket.jobId,ticket.tenantId,ticket.attempt])
      if (!charges.length || charges.some(c => !Number.isFinite(c.actual) || c.actual < 0)) throw new Error('private_baseline_not_complete')
      const micros = charges.reduce((n,c)=>n+Math.ceil(c.actual*1_000_000-1e-8),0)
      if (!Number.isSafeInteger(micros) || micros > 5_000_000) throw new Error('private_baseline_not_complete')
      return micros
    })
  } catch { return null }
}
