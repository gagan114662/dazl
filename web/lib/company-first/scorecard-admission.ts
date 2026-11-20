import { createHmac, timingSafeEqual } from 'node:crypto'
import { SpendRefused } from '../llm/spend-guard.ts'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { QA_LOCAL_EXECUTION, qaClaudeOnlyBudget } from '../scan/qa-provider-policy.ts'

// Private protocol: protected issuer signs reviewed cases; ordinary scan routes
// and callers never mint or supply authority. No prompts/companies are stored.
const LANES = ['old', 'new', 'judge'] as const
export type ScorecardLane = typeof LANES[number]
const MAX_CASE = 5_000_000, MAX_COHORT = 35_000_000
const SHA = /^[a-f0-9]{64}$/
const JOB = /^[a-f0-9]{24}$/
const ID = /^[a-zA-Z0-9_-]{1,100}$/
const sha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v)
type Claim = { tenantId: string; actorId: string; jobId: string; attempt: number }
type Words = Claim & { subjectMac: string; release: string; lane: ScorecardLane } & { workspaceRevision: string; cohort: string; ordinal: number; nonce: string; expiresAt: number; presets: readonly string[] }
export type WorkspaceGate = (t: Tx, x: { tenantId: string; actorId: string; workspaceRevision: string }) => TxBody<boolean>
export const SCORECARD_ADMISSION_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS company_scorecard_cohorts (
    cohort TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_revision TEXT NOT NULL, release TEXT NOT NULL, roster TEXT NOT NULL, next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 1 AND 8)
  )`,
  `CREATE TABLE IF NOT EXISTS company_scorecard_claims (
    nonce TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    cohort TEXT NOT NULL REFERENCES company_scorecard_cohorts(cohort) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 7), job_id TEXT NOT NULL,
    subject_mac TEXT NOT NULL CHECK(length(subject_mac)=64),
    attempt INTEGER NOT NULL CHECK(attempt > 0), expires_at BIGINT NOT NULL,
    lane INTEGER NOT NULL CHECK(lane BETWEEN 0 AND 2),
    status TEXT NOT NULL CHECK(status IN ('running','complete')),
    UNIQUE(cohort, ordinal, lane), UNIQUE(job_id)
  )`,
  `CREATE TABLE IF NOT EXISTS company_scorecard_calls (
    reservation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    nonce TEXT NOT NULL REFERENCES company_scorecard_claims(nonce) ON DELETE CASCADE,
    lane INTEGER NOT NULL CHECK(lane BETWEEN 0 AND 2)
  )`,
])
const authentic = new WeakMap<object, Uint8Array>()
export type VerifiedScorecardTicket = Readonly<Words>

/** Token is an issuer's base64url JSON tuple payload plus its lowercase hex tag.
 * Caller must obtain the signing key from the protected issuer configuration;
 * do not log a token, key, tuple, or source scope. No default key or signer. */
export function verifyScorecardTicket(token: string, key: Uint8Array, expected: Claim & { release: string }, now: number): VerifiedScorecardTicket | null {
  if (typeof token !== 'string' || token.length > 2000 || key.byteLength < 32 ||
      !Number.isSafeInteger(now) || now < 1) return null
  const [encoded, tag, extra] = token.split('.')
  if (extra !== undefined || !/^[a-zA-Z0-9_-]+$/.test(encoded ?? '') || !sha(tag)) return null
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) return null
  const mac = createHmac('sha256', key).update('dazl-scorecard-ticket:v1\n').update(encoded).digest()
  if (!timingSafeEqual(mac, Buffer.from(tag, 'hex'))) return null
  try {
    const tuple = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(tuple) || tuple.length !== 13) return null
    const [tenantId, actorId, jobId, attempt, workspaceRevision, cohort, ordinal, nonce, expiresAt, presets, subjectMac, release, lane] = tuple
    if (![tenantId, actorId].every(x => typeof x === 'string' && ID.test(x)) ||
        typeof jobId !== 'string' || !JOB.test(jobId) || !Number.isSafeInteger(attempt) || attempt < 1 ||
        tenantId !== expected.tenantId || actorId !== expected.actorId || jobId !== expected.jobId || attempt !== expected.attempt ||
        ![workspaceRevision, cohort, nonce, subjectMac].every(sha) || typeof release !== 'string' || !/^[a-f0-9]{40}$/.test(release) || release !== expected.release || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 7 ||
        !LANES.includes(lane) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > 3_600_000 ||
        !Array.isArray(presets) || presets.length !== 7 || !presets.every(sha) || new Set(presets).size !== 7) return null
    const ticket = Object.freeze({ tenantId, actorId, jobId, attempt, workspaceRevision, cohort, ordinal, nonce, expiresAt,
      subjectMac, release, lane, presets: Object.freeze([...presets] as string[]) })
    authentic.set(ticket, Uint8Array.from(key))
    return ticket
  } catch { return null }
}
const active = (x: VerifiedScorecardTicket, now: number) =>
  !!x && authentic.has(x) && Number.isSafeInteger(now) && now > 0 && now < x.expiresAt
const claimLock = (t: Tx, x: Claim, status: 'running' | 'done') =>
  t.run('UPDATE scan_jobs SET attempts = attempts WHERE id = ? AND user_id = ? AND attempts = ? AND status = ? AND error IS NULL',
    [x.jobId, x.tenantId, x.attempt, status])
export const SCORECARD_ANCHOR = Object.freeze({business_name:'Private scorecard'})
export const scorecardRawBudget = () => qaClaudeOnlyBudget(JSON.stringify({first5:true}),true)
export const scorecardPinnedBudget = () => JSON.stringify({...JSON.parse(scorecardRawBudget()),execution:QA_LOCAL_EXECUTION})
export type ScorecardSubjectInput = Readonly<{query:string;icp?:string|null;sources?:string|null;seller?:string|null;offer?:string|null}>
type Subject = Readonly<{query:string;icp:string;sources:string|null;seller:string|null;offer:string|null}>
type AuthorizedSubject = Readonly<{ subject: Subject }>
const subjects = new WeakMap<AuthorizedSubject,VerifiedScorecardTicket>()
function boundedJson(x: unknown, max: number): x is string {
  if (typeof x !== 'string' || Buffer.byteLength(x) > max) return false
  try { const parsed=JSON.parse(x); return !!parsed && typeof parsed === 'object' } catch { return false }
}
/** Verify the exact approved reviewed inputs in memory, before either the
 * primary financial anchor or the ephemeral scratch can be instantiated. */
export function authorizeScorecardSubject(x: VerifiedScorecardTicket, input: ScorecardSubjectInput, clock = Date.now): AuthorizedSubject | null {
  const key = authentic.get(x)
  if (!key || !active(x,clock()) || !input || typeof input.query !== 'string' || input.query.length < 3 || input.query.length > 600 ||
      input.query.trim() !== input.query || !boundedJson(input.icp,32_768) ||
      (input.sources != null && !boundedJson(input.sources,8_192)) ||
      (input.seller != null && (typeof input.seller !== 'string' || input.seller.length > 300)) ||
      (input.offer != null && (typeof input.offer !== 'string' || input.offer.length > 150))) return null
  const subject = Object.freeze({query:input.query,icp:input.icp,sources:input.sources??null,
    seller:input.seller?.trim()||null,offer:input.offer?.replace(/\s+/g,' ').trim()||null})
  const expected = createHmac('sha256', key).update(JSON.stringify(['legacy-observation-v1',x.actorId,x.tenantId,x.jobId,x.attempt,
    Math.floor(x.expiresAt / 1000),subject.query,subject.icp,subject.offer,subject.seller,subject.sources,scorecardPinnedBudget()])).digest()
  if (!timingSafeEqual(expected, Buffer.from(x.subjectMac,'hex'))) return null
  const proof = Object.freeze({subject})
  subjects.set(proof,x)
  return proof
}
function* exactJob(t: Tx, x: VerifiedScorecardTicket): TxBody<boolean> {
  return !!(yield* t.get(`SELECT 1 FROM scan_jobs WHERE id=? AND user_id=? AND business_name=?
    AND query IS NULL AND icp IS NULL AND seller IS NULL AND offer IS NULL AND sources IS NULL
    AND icp_inferred IS NULL AND run_budget=? AND funded_by='user' AND csv_domain IS NULL AND watch_id IS NULL`,
  [x.jobId,x.tenantId,SCORECARD_ANCHOR.business_name,scorecardPinnedBudget()]))
}
const binding = (x: VerifiedScorecardTicket) => [x.cohort, x.tenantId, x.actorId, x.workspaceRevision, x.release, JSON.stringify(x.presets)]
// Protected producer uses this in the same transaction as canonical job creation,
// strict claim and durable dispatch tagging. Do not return false and commit a
// partly staged job: caller MUST throw on refusal.
export function* registerScorecardTicket(t: Tx, x: VerifiedScorecardTicket, gate: WorkspaceGate, proof: AuthorizedSubject | null, clock = Date.now): TxBody<boolean> {
  if (!proof || subjects.get(proof)!==x || !active(x, clock())) return false
  if (!(yield* gate(t, x)) || (yield* claimLock(t, x, 'running')).changes !== 1 || !(yield* exactJob(t, x)) || !active(x, clock())) return false
  const step = LANES.indexOf(x.lane)
  if (x.ordinal === 1 && step === 0) yield* t.run(`INSERT INTO company_scorecard_cohorts (cohort, tenant_id, actor_id, workspace_revision, release, roster, next_ordinal)
    VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`, binding(x))
  const lock = yield* t.run(`UPDATE company_scorecard_cohorts SET next_ordinal = next_ordinal
    WHERE cohort = ? AND tenant_id = ? AND actor_id = ? AND workspace_revision = ? AND release = ? AND roster = ? AND next_ordinal = ?`, [...binding(x), x.ordinal])
  if (lock.changes !== 1 || !active(x, clock())) return false
  if (step > 0 && !(yield* t.get("SELECT 1 FROM company_scorecard_claims WHERE cohort=? AND ordinal=? AND lane=? AND status='complete'", [x.cohort,x.ordinal,step-1]))) return false
  return (yield* t.run(`INSERT INTO company_scorecard_claims
    (nonce, tenant_id, cohort, ordinal, job_id, subject_mac, attempt, expires_at, lane, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running') ON CONFLICT DO NOTHING`,
  [x.nonce, x.tenantId, x.cohort, x.ordinal, x.jobId, x.subjectMac, x.attempt, x.expiresAt,step])).changes === 1
}
export async function consumeScorecardTicket(db: Db, x: VerifiedScorecardTicket, gate: WorkspaceGate, proof: AuthorizedSubject | null, clock = Date.now): Promise<boolean> {
  try { return await db.tx(t => registerScorecardTicket(t,x,gate,proof,clock)) }
  catch { return false }
}

type CanonicalCall = { id: string; scan_job_id: string; user_id: string; attempt: number|string; status: string;
  reserve_usd: number|string; actual_usd: number|string|null; kind: string; ordinal: number|string; settled_at: number|string|null }
const readCalls = (t: Tx, x: VerifiedScorecardTicket) => t.all<CanonicalCall>(`
  SELECT s.id, s.scan_job_id, s.user_id, s.attempt, s.status, s.reserve_usd, s.actual_usd, s.kind, s.settled_at, c.ordinal
    FROM company_scorecard_calls b JOIN company_scorecard_claims c ON c.nonce = b.nonce
    JOIN scan_spend_calls s ON s.id = b.reservation_id AND s.scan_job_id = c.job_id AND s.attempt = c.attempt
   WHERE c.cohort = ? AND s.user_id = ? LIMIT 1001`, [x.cohort, x.tenantId])
// Round up ledger numbers, never down (half-micro amounts included).
const usdMicros = (v: unknown) => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v))) return null
  const n = Math.ceil(Number(v) * 1_000_000)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}
const claude = (kind: string) => kind === 'llm.anthropic' || kind === 'llm.anthropic.web_search'
const spent = (calls: readonly CanonicalCall[], ordinal?: number): number | null => {
  let n = 0
  for (const c of calls) {
    if (ordinal && ordinal !== Number(c.ordinal)) continue
    const actual = usdMicros(c.actual_usd), reserved = usdMicros(c.reserve_usd)
    if (c.status !== 'settled' || c.settled_at == null || actual === null || reserved === null || actual > reserved || !claude(c.kind)) return null
    n += actual
  }
  return Number.isSafeInteger(n) ? n : null
}
const scoped = (t: Tx, x: VerifiedScorecardTicket) => t.run(`UPDATE company_scorecard_cohorts SET next_ordinal = next_ordinal
  WHERE cohort = ? AND tenant_id = ? AND actor_id = ? AND workspace_revision = ? AND release = ? AND roster = ? AND next_ordinal = ?`, [...binding(x), x.ordinal])

/** Call inside the canonical scan spend transaction immediately AFTER its
 * reservation row was inserted. Throw on refusal; rollback the canonical job
 * and account reservations too. MUST run before transport and on EVERY paid
 * call on an admitted claim, including classic. The normal guard still enforces
 * lower account/job limits; this never substitutes for them. */
export function* requireCombinedScorecardReservation(t: Tx, x: VerifiedScorecardTicket, gate: WorkspaceGate,
  lane: ScorecardLane, reservationId: string, clock = Date.now): TxBody<void> {
  const deny = () => { throw new SpendRefused('scorecard_spend_refused') }
  const step = LANES.indexOf(lane)
  if (!active(x, clock()) || step < 0 || lane !== x.lane || !ID.test(reservationId) || !(yield* gate(t, x)) ||
      (yield* claimLock(t, x, 'running')).changes !== 1 || (yield* scoped(t, x)).changes !== 1 || !(yield* exactJob(t, x)) || !active(x, clock())) return deny()
  const claim = yield* t.get<{ lane: number|string }>(`SELECT lane FROM company_scorecard_claims WHERE nonce = ?
    AND cohort = ? AND job_id = ? AND attempt = ? AND status = 'running' AND expires_at = ? AND subject_mac = ?`,
  [x.nonce, x.cohort, x.jobId, x.attempt, x.expiresAt,x.subjectMac])
  if (!claim || step !== Number(claim.lane)) return deny()
  const row = yield* t.get<CanonicalCall>(`SELECT id, scan_job_id, user_id, attempt, kind, status, reserve_usd
    FROM scan_spend_calls WHERE id = ? AND user_id = ? AND scan_job_id = ? AND attempt = ?`, [reservationId,x.tenantId,x.jobId,x.attempt])
  const reserve = usdMicros(row?.reserve_usd)
  if (!row || !claude(row.kind) || row.status !== 'reserved' || reserve === null || reserve < 1 || reserve > MAX_CASE) return deny()
  const calls = yield* readCalls(t, x)
  if (calls.length > 1000) return deny()
  const n = spent(calls), caseN = spent(calls, x.ordinal)
  // Unknown or uncovered canonical attempts may have billed: no new cohort
  // call. Verify coverage from canonical AND joined sides (deletion not zero).
  const coverage = yield* t.get<{ n: number|string }>(`SELECT COUNT(*) AS n FROM company_scorecard_calls b
    JOIN company_scorecard_claims c ON c.nonce = b.nonce WHERE c.cohort = ?`, [x.cohort])
  if (Number(coverage?.n) !== calls.length || (yield* t.get(`SELECT 1 FROM scan_spend_calls s WHERE s.user_id = ?
      AND s.scan_job_id = ? AND s.id <> ? AND (s.status = 'reserved' OR s.status = 'settled')
      AND NOT EXISTS (SELECT 1 FROM company_scorecard_calls b WHERE b.reservation_id = s.id AND b.nonce = ?) LIMIT 1`,
  [x.tenantId,x.jobId,reservationId,x.nonce])) || n === null || caseN === null ||
      n+reserve > MAX_COHORT || caseN+reserve > MAX_CASE || !active(x, clock())) return deny()
  if ((yield* t.run('INSERT INTO company_scorecard_calls (reservation_id, tenant_id, nonce, lane) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    [reservationId,x.tenantId,x.nonce,step])).changes !== 1) return deny()
}

/** For worker dispatch/restart checks; validates existing consumption without
 * granting a retry, changing lane, or creating a new ticket. Controller must
 * consume once only after the normal claim, and must not restart an in-flight
 * job on a matching row. A later canonical hook still rechecks under lock. */
export function* requireExistingScorecardClaim(t: Tx, x: VerifiedScorecardTicket, gate: WorkspaceGate, clock = Date.now): TxBody<boolean> {
  if (!active(x, clock()) || !(yield* gate(t,x)) || (yield* claimLock(t,x,'running')).changes !== 1 ||
      !(yield* exactJob(t,x)) || (yield* scoped(t,x)).changes !== 1 || !active(x,clock())) return false
  return !!(yield* t.get(`SELECT 1 FROM company_scorecard_claims c WHERE c.nonce=? AND c.cohort=? AND c.ordinal=?
      AND c.job_id=? AND c.attempt=? AND c.expires_at=? AND c.status='running' AND c.lane=? AND c.subject_mac=?
      AND NOT EXISTS (SELECT 1 FROM scan_spend_calls s WHERE s.user_id=? AND s.scan_job_id=? AND s.status IN ('reserved','settled'))`,
  [x.nonce,x.cohort,x.ordinal,x.jobId,x.attempt,x.expiresAt,LANES.indexOf(x.lane),x.subjectMac,x.tenantId,x.jobId])) && active(x,clock())
}
export async function verifyExistingScorecardClaim(db: Db, x: VerifiedScorecardTicket, gate: WorkspaceGate, clock = Date.now): Promise<boolean> {
  try { return await db.tx(t => requireExistingScorecardClaim(t,x,gate,clock)) }
  catch { return false }
}

/** Mark only billing completion, never proof/quality/scorecard acceptance.
 * Worker calls after its own successful terminal transition for this exact
 * lane/job. Next arm only after predecessor complete; next case only after
 * judge completes; unknown or overrun blocks both. */
export function* completeScorecardBillingTx(t: Tx, x: VerifiedScorecardTicket, gate: WorkspaceGate, clock = Date.now): TxBody<boolean> {
  if (!active(x, clock())) return false
  if (!(yield* gate(t,x)) || (yield* claimLock(t,x,'done')).changes !== 1 || !(yield* exactJob(t,x)) ||
      (yield* scoped(t,x)).changes !== 1 || !active(x,clock())) return false
  const calls = yield* readCalls(t,x)
  if (calls.length > 1000) return false
  const n = spent(calls), caseN = spent(calls,x.ordinal)
  const present = yield* t.all<{ lane: number|string }>(`
    SELECT DISTINCT b.lane FROM company_scorecard_calls b
    JOIN scan_spend_calls s ON s.id=b.reservation_id AND s.scan_job_id=? AND s.user_id=? AND s.attempt=?
    WHERE b.nonce=?`, [x.jobId,x.tenantId,x.attempt,x.nonce])
  const extra = yield* t.get(`SELECT 1 FROM scan_spend_calls s WHERE s.user_id=? AND s.scan_job_id=?
    AND (s.status='settled' OR s.status='reserved') AND NOT EXISTS
      (SELECT 1 FROM company_scorecard_calls b WHERE b.reservation_id=s.id AND b.nonce=?) LIMIT 1`, [x.tenantId,x.jobId,x.nonce])
  const coverage = yield* t.get<{ n: number|string }>(`SELECT COUNT(*) AS n FROM company_scorecard_calls b
    JOIN company_scorecard_claims c ON c.nonce=b.nonce WHERE c.cohort=?`, [x.cohort])
  const step = LANES.indexOf(x.lane)
  if (present.length !== 1 || Number(present[0].lane) !== step || extra || Number(coverage?.n) !== calls.length || n === null || caseN === null ||
      n > MAX_COHORT || caseN > MAX_CASE || !active(x,clock())) return false
  const changed = yield* t.run("UPDATE company_scorecard_claims SET status='complete' WHERE nonce=? AND cohort=? AND ordinal=? AND subject_mac=? AND status='running'",
    [x.nonce,x.cohort,x.ordinal,x.subjectMac])
  if (changed.changes !== 1) return false
  if (x.lane === 'judge') yield* t.run('UPDATE company_scorecard_cohorts SET next_ordinal=? WHERE cohort=? AND next_ordinal=?', [x.ordinal+1,x.cohort,x.ordinal])
  return true
}

export async function completeScorecardBilling(db: Db, x: VerifiedScorecardTicket, gate: WorkspaceGate, clock = Date.now): Promise<boolean> {
  try { return await db.tx(t => completeScorecardBillingTx(t,x,gate,clock)) }
  catch { return false }
}
