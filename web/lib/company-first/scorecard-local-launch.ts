// Internal composition only. No public request, queue, credential/env reader,
// signer, enrollment, or option to replace the canonical runner lives here.
import type Database from 'better-sqlite3'
import { sqliteDb } from '../db/client.ts'
import { strictLocalTopologySupported } from '../scan/qa-provider-policy.ts'
import type { Job } from '../scan/runner.ts'
import { reserveStrictLocalSlot } from '../scan/strict-local-launch.ts'
import { authorizeScorecardSubject, verifyScorecardTicket, type ScorecardSubjectInput } from './scorecard-admission.ts'
import { armProtectedScorecardJobSqlite } from './scorecard-producer.ts'
import { runProtectedScorecardScanArm } from './scorecard-worker-arm.ts'
import { preflightProtectedStagingScorecard } from './scorecard-staging-preflight.ts'
import { allowStagingProof, type StagingProofRequest } from './scorecard-staging-proof.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'

type Scope = Readonly<{ tenantId: string; actorId: string; release: string }>
type Input = Readonly<{ jobId: string; signedToken: string; reviewedInput: ScorecardSubjectInput }>
type Binder = Parameters<typeof runProtectedScorecardScanArm>[3]
type Result = Awaited<ReturnType<typeof runProtectedScorecardScanArm>>
type Ports = Readonly<{
  // Provisioned only by the trusted same-process composition, never from an
  // HTTP body or a global default. The loader configures a binder; it must
  // not fetch, dispatch, or spend while preparing it.
  signer: Uint8Array | null
  stagingCaseOne?: Readonly<{
    host: Parameters<typeof preflightProtectedStagingScorecard>[1]
    proofRequest: StagingProofRequest
  }>
  loadBinding(scope: Scope & Readonly<{ jobId: string; lane: 'old' | 'new' }>): Promise<Binder | null>
}>
const refused = Object.freeze({ state: 'held', reason: 'unauthorized_or_incomplete' } as const)

export async function launchReviewedLocalScorecardArm(db: Database.Database, trustedScope: Scope, ports: Ports,
  input: Input, signal: AbortSignal): Promise<Result> {
  let releaseSlot: (() => void) | null = null
  try {
    if (signal.aborted || process.env.DATABASE_URL || !strictLocalTopologySupported('sqlite') ||
        db.inTransaction || !(ports.signer instanceof Uint8Array) || ports.signer.byteLength < 32 ||
        typeof ports.loadBinding !== 'function') return refused
    const signingKey = Uint8Array.from(ports.signer)
    const scope = Object.freeze({ tenantId: trustedScope.tenantId, actorId: trustedScope.actorId, release: trustedScope.release })
    const staging=ports.stagingCaseOne
    const mode=staging?'staging-case-one' as const:undefined
    const { signedToken, jobId } = input
    const ticket = verifyScorecardTicket(signedToken, signingKey, { ...scope, jobId, attempt: 1 }, Date.now(),mode)
    if (!ticket || ticket.lane === 'judge') return refused
    const requireStaging=()=>!staging||(!db.readonly&&
      preflightProtectedStagingScorecard(db,staging.host,ticket).state==='preflight_passed'&&
      allowStagingProof(ticket,staging.proofRequest))
    if(!requireStaging()) return refused
    const proof = authorizeScorecardSubject(ticket, input.reviewedInput)
    if (!proof) return refused
    const reviewedInput = proof.subject // snapshot canonical bytes; no caller mutation across await
    const eligible = await sqliteDb(db).tx(t => requireScorecardWorkspace(t, ticket))
    if (!eligible || signal.aborted) return refused
    const bind = await ports.loadBinding(Object.freeze({ ...scope, jobId, lane: ticket.lane }))
    if (typeof bind !== 'function' || signal.aborted || process.env.DATABASE_URL || !strictLocalTopologySupported('sqlite') || !requireStaging()) return refused
    // Producer rechecks signed subject/expiry, workspace, quota, vendor and
    // attempt in the real IMMEDIATE transaction after async binding preparation.
    releaseSlot = reserveStrictLocalSlot()
    if (!releaseSlot || !armProtectedScorecardJobSqlite(db, ticket, reviewedInput).ok) return refused
    const job = db.prepare(`SELECT * FROM scan_jobs WHERE id=? AND user_id=? AND attempts=1
      AND status='running' AND company_scorecard_claim_nonce=?`).get(jobId, scope.tenantId, ticket.nonce) as Job | undefined
    if (!job) return refused
    // Never hand back or retry an admitted attempt. Any interruption is
    // covered by the existing durable private marker and reaper.
    return await runProtectedScorecardScanArm(db, Object.freeze(job), {
      release: scope.release, signedToken, signingKey, reviewedInput, mode,
    }, bind, signal,staging?.proofRequest)
  } catch {
    // No identity, private subject, key, signature, or raw exception leaves this boundary.
    return refused
  } finally { releaseSlot?.() }
}
