import type { Db, Tx, TxBody } from '../db/client.ts'
import {
  requireCombinedScorecardReservation, requireExistingScorecardClaim, verifyScorecardTicket, SCORECARD_ANCHOR, scorecardPinnedBudget,
  type ScorecardLane, type VerifiedScorecardTicket,
} from './scorecard-admission.ts'
import { requireScorecardWorkspace } from './scorecard-workspace.ts'

export const SCORECARD_DISPATCH_COLUMNS = [
  "ALTER TABLE scan_jobs ADD COLUMN company_scorecard_claim_nonce TEXT CHECK (company_scorecard_claim_nonce IS NULL OR status <> 'pending')",
  'ALTER TABLE scan_jobs ADD COLUMN company_scorecard_dispatch_started_at BIGINT',
  "ALTER TABLE scan_jobs ADD COLUMN company_scorecard_dispatch_release TEXT CHECK (company_scorecard_dispatch_release IS NULL OR (length(company_scorecard_dispatch_release)=40 AND company_scorecard_dispatch_release NOT GLOB '*[^0-9a-f]*'))",
] as const

export const SCORECARD_DISPATCH_GUARDS_SQLITE = `
  CREATE TRIGGER IF NOT EXISTS company_scorecard_marker_immutable
    BEFORE UPDATE OF company_scorecard_claim_nonce ON scan_jobs
    WHEN OLD.company_scorecard_claim_nonce IS NOT NEW.company_scorecard_claim_nonce AND NOT (
      OLD.company_scorecard_claim_nonce IS NULL AND NEW.company_scorecard_claim_nonce IS NOT NULL
      AND length(NEW.company_scorecard_claim_nonce) = 64
      AND OLD.status='running' AND NEW.status='running' AND OLD.attempts=1 AND NEW.attempts=1
      AND OLD.company_scorecard_dispatch_started_at IS NULL AND NEW.company_scorecard_dispatch_started_at IS NULL
      AND NEW.id=OLD.id AND NEW.user_id=OLD.user_id
      AND EXISTS (SELECT 1 FROM company_scorecard_claims c
        WHERE c.nonce=NEW.company_scorecard_claim_nonce AND c.job_id=NEW.id
          AND c.tenant_id=NEW.user_id AND c.attempt=NEW.attempts AND c.status='running')
    )
    BEGIN SELECT RAISE(ABORT, 'scorecard marker immutable'); END;
  CREATE TRIGGER IF NOT EXISTS company_scorecard_dispatch_stamp
    BEFORE UPDATE OF company_scorecard_dispatch_started_at, company_scorecard_dispatch_release ON scan_jobs
    WHEN (OLD.company_scorecard_dispatch_started_at IS NOT NEW.company_scorecard_dispatch_started_at
          OR OLD.company_scorecard_dispatch_release IS NOT NEW.company_scorecard_dispatch_release) AND NOT (
      OLD.company_scorecard_dispatch_started_at IS NULL AND OLD.company_scorecard_dispatch_release IS NULL
      AND NEW.company_scorecard_dispatch_started_at IS NOT NULL AND NEW.company_scorecard_dispatch_started_at > 0
      AND NEW.company_scorecard_dispatch_release IS NOT NULL AND OLD.status='running' AND NEW.status='running'
      AND NEW.company_scorecard_claim_nonce=OLD.company_scorecard_claim_nonce
      AND NEW.id=OLD.id AND NEW.user_id=OLD.user_id AND NEW.attempts=OLD.attempts
      AND EXISTS (SELECT 1 FROM company_scorecard_claims c JOIN company_scorecard_cohorts p ON p.cohort=c.cohort
        WHERE c.nonce=NEW.company_scorecard_claim_nonce AND c.job_id=NEW.id AND c.attempt=NEW.attempts
          AND p.tenant_id=NEW.user_id AND p.release=NEW.company_scorecard_dispatch_release AND c.status='running')
    )
    BEGIN SELECT RAISE(ABORT, 'scorecard dispatch stamp immutable'); END;
  CREATE TRIGGER IF NOT EXISTS company_scorecard_no_handback
    BEFORE UPDATE OF status ON scan_jobs
    WHEN OLD.company_scorecard_claim_nonce IS NOT NULL AND OLD.status='running' AND NEW.status='pending'
    BEGIN
      UPDATE scan_jobs SET status='failed', claimed_at=NULL, finished_at=unixepoch(),
        error=CASE WHEN EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id=OLD.id AND c.status='reserved')
          THEN 'accounting_uncertain' ELSE 'scorecard_dispatch_failed' END
      WHERE id=OLD.id AND user_id=OLD.user_id AND status='running' AND attempts=OLD.attempts;
      SELECT RAISE(IGNORE);
    END;
`
type SqliteMigrationHandle = {
  prepare(sql: string): { all(): unknown[] }
  exec(sql: string): unknown
  transaction<T>(fn: () => T): { immediate(): T }
}
// Partial scan stores still use the canonical row shape, but cannot enroll or
// dispatch a scorecard. Do not create triggers referencing primary-only tables.
export function migrateScorecardDispatchColumnsSqlite(db: SqliteMigrationHandle): void {
  db.transaction(() => {
    const columns = db.prepare("PRAGMA table_info('scan_jobs')").all() as { name: string }[]
    for (const [i, name] of ['company_scorecard_claim_nonce', 'company_scorecard_dispatch_started_at', 'company_scorecard_dispatch_release'].entries()) {
      if (!columns.some(c => c.name === name)) db.exec(SCORECARD_DISPATCH_COLUMNS[i])
    }
  }).immediate()
}

// Only after the primary claim/cohort and spend tables have been provisioned.
export function migrateScorecardDispatchSqlite(db: SqliteMigrationHandle): void {
  db.transaction(() => {
    migrateScorecardDispatchColumnsSqlite(db)
    db.exec(SCORECARD_DISPATCH_GUARDS_SQLITE)
  }).immediate()
}

type Claimed = Readonly<{ id: string; user_id: string; attempts: number }>
type TicketScope = Readonly<{ tenantId: string; actorId: string; jobId: string; attempt: number; release: string; nonce: string; lane: ScorecardLane }>
type TicketMaterial = Readonly<{ signedToken: string; signingKey: Uint8Array; mode?: 'staging-case-one' }>
type Failure = 'scorecard_dispatch_unavailable' | 'scorecard_dispatch_refused' | 'scorecard_dispatch_started' | 'scorecard_dispatch_failed'
type Legacy = 'done' | 'failed' | 'retry'

export type ScorecardDispatchResult =
  | { route: 'legacy'; status: Legacy }
  | { route: 'scorecard'; status: 'callback_returned' }
  | { route: 'scorecard'; status: 'refused'; reason: Failure }

export type AuthorizedScorecardExecution = Readonly<{
  ticket: VerifiedScorecardTicket
  vendor: 'anthropic'
  funding: 'workspace_owned'
  // Must be delegated to from inside EVERY canonical reservation transaction
  // before calling the provider. This is not permission to send or publish.
  requireReservation(t: Tx, reservationId: string): TxBody<void>
}>

export type ProtectedScorecardWorker = Readonly<{
  // Exact trusted deployment identity (never a header/caller override).
  release: string
  // Protected local server control-plane seam, never a request-supplied token,
  // provider, or automatic fetch. No lookup for ordinary or revoked work.
  materialFor(scope: TicketScope): Promise<TicketMaterial | null>
  // Must run baseline, candidate, and judge through canonical guard with the
  // reservation hook. No legacy runner callback or ordinary publication path.
  runPrivate(execution: AuthorizedScorecardExecution): Promise<void>
}>

const refuse = (reason: Failure): ScorecardDispatchResult => ({ route: 'scorecard', status: 'refused', reason })
const lowerHex64 = /^[a-f0-9]{64}$/
type JobRow = { nonce: string | null; started: string | number | null; release: string | null; status: string; attempts: number | string; funded_by: string; csv_domain: string | null; watch_id: string | null }
type ClaimRow = { actorId: string; revision: string; expires: number | string; lane: number | string }
function* privateJobShape(t: Tx, job: Claimed): TxBody<boolean> {
  const row = yield* t.get<{ run_budget: string | null }>(`
    SELECT j.run_budget FROM scan_jobs j WHERE j.id=? AND j.user_id=? AND j.attempts=?
      AND j.status='running' AND j.error IS NULL AND j.funded_by='user' AND j.csv_domain IS NULL AND j.watch_id IS NULL
      AND j.business_name=? AND j.run_budget=?
      AND j.query IS NULL AND j.icp IS NULL AND j.sources IS NULL AND j.seller IS NULL AND j.offer IS NULL AND j.icp_inferred IS NULL
      AND NOT EXISTS (SELECT 1 FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id
        WHERE r.job_id=j.id AND m.user_id=j.user_id)`, [job.id, job.user_id, job.attempts,SCORECARD_ANCHOR.business_name,scorecardPinnedBudget()])
  return !!row
}

/** Invoke once at the genuine runner entry before tracing/reading keys. A DB
 * failure is not evidence of an ordinary job. Marked jobs have no legacy path,
 * regardless of attempt, missing state, ticket refusal or thrown callback. */
export async function dispatchScorecardAware(
  db: Db, job: Claimed, ordinary: () => Promise<Legacy>, worker?: ProtectedScorecardWorker, clock = Date.now,
): Promise<ScorecardDispatchResult> {
  let claimed: JobRow | undefined
  try {
    claimed = await db.get<JobRow>(`
      SELECT company_scorecard_claim_nonce AS nonce, company_scorecard_dispatch_started_at AS started,
             company_scorecard_dispatch_release AS release,
             funded_by,csv_domain,watch_id,status,attempts
      FROM scan_jobs WHERE id=? AND user_id=?`, [job.id, job.user_id])
  } catch { return refuse('scorecard_dispatch_unavailable') }
  if (!claimed || Number(claimed.attempts) !== job.attempts) return refuse('scorecard_dispatch_refused')
  if (claimed.nonce === null && claimed.started === null && claimed.release === null) return { route: 'legacy', status: await ordinary() }
  if (!worker || !/^[a-f0-9]{40}$/.test(worker.release)) return refuse('scorecard_dispatch_unavailable')
  if (typeof claimed.nonce !== 'string' || !lowerHex64.test(claimed.nonce) || claimed.status !== 'running' || Number(claimed.attempts) !== job.attempts ||
      claimed.funded_by !== 'user' || claimed.csv_domain !== null || claimed.watch_id !== null)
    return refuse('scorecard_dispatch_refused')
  if (claimed.started !== null || claimed.release !== null) return refuse('scorecard_dispatch_started')
  const nonce = claimed.nonce
  let ticket: VerifiedScorecardTicket | null
  try {
    const binding = await db.tx(function* (t) {
      const row = yield* t.get<ClaimRow>(`
        SELECT p.actor_id AS "actorId", p.workspace_revision AS revision, c.expires_at AS expires, c.lane
        FROM company_scorecard_claims c JOIN company_scorecard_cohorts p ON p.cohort=c.cohort
        WHERE c.nonce=? AND c.job_id=? AND c.attempt=? AND p.tenant_id=?
          AND c.status='running' AND p.release=? AND p.next_ordinal=c.ordinal`,
      [nonce, job.id, job.attempts, job.user_id, worker.release])
      if (!row || Number(row.expires) <= clock() || !(yield* privateJobShape(t, job)) ||
          !(yield* requireScorecardWorkspace(t, { tenantId: job.user_id, actorId: row.actorId, workspaceRevision: row.revision }))) return null
      return row
    })
    const lane = binding ? (['old', 'new', 'judge'] as const)[Number(binding.lane)] : undefined
    if (!binding || !lane) return refuse('scorecard_dispatch_refused')
    const scope = Object.freeze({ tenantId: job.user_id, actorId: binding.actorId, jobId: job.id, attempt: job.attempts, release: worker.release, nonce, lane })
    const material = await worker.materialFor(scope)
    ticket = material ? verifyScorecardTicket(material.signedToken, material.signingKey, scope, clock(), material.mode) : null
    if (!ticket || ticket.lane !== lane || ticket.nonce !== nonce || ticket.workspaceRevision !== binding.revision || ticket.expiresAt !== Number(binding.expires))
      return refuse('scorecard_dispatch_refused')
    const exact = ticket
    const started = await db.tx(function* (t) {
      if (!(yield* requireExistingScorecardClaim(t, exact, requireScorecardWorkspace, clock)) ||
          !(yield* privateJobShape(t, job))) return false
      const now = clock()
      if (!Number.isSafeInteger(now) || now <= 0 || now >= exact.expiresAt) return false
      const guard = yield* t.run(`UPDATE scan_jobs SET company_scorecard_dispatch_started_at=?, company_scorecard_dispatch_release=?
        WHERE id=? AND user_id=? AND attempts=? AND status='running' AND error IS NULL
          AND company_scorecard_claim_nonce=? AND company_scorecard_dispatch_started_at IS NULL AND company_scorecard_dispatch_release IS NULL`,
      [now, exact.release, job.id, job.user_id, job.attempts, nonce])
      return guard.changes === 1
    })
    // Another worker may have won. This result is not authority to finalize
    // or cancel its still-running row. The stale reaper owns recovery.
    if (!started) return refuse('scorecard_dispatch_refused')
  } catch { return refuse('scorecard_dispatch_unavailable') }

  try {
    const exact = ticket
    await worker.runPrivate(Object.freeze({
      ticket: exact, vendor: 'anthropic', funding: 'workspace_owned',
      requireReservation: (t: Tx, reservationId: string) =>
        requireCombinedScorecardReservation(t, exact, requireScorecardWorkspace, exact.lane, reservationId, clock),
    }))
    return { route: 'scorecard', status: 'callback_returned' }
  } catch {
    // A thrown private callback may have reserved or billed; preserve the
    // marker and accounting for reconciliation. No retry or legacy fallback.
    return refuse('scorecard_dispatch_failed')
  }
}
