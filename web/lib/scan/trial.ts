import { createHash } from 'node:crypto'
import type { Db } from '../db/client.ts'
import type Database from 'better-sqlite3'
import { migrateTrialBudget, trialQaExempt, trialQaExemptAccount, trialScanAllowance } from '../billing/trial-budget.ts'

// Free trial: a few scans per new account run on the server's shared operator key, so a new
// user can see real results before adding their own AI key. Abuse limits sit on top:
// a hard per-account cap and a per-IP daily throttle. The operator key lives only in the
// server environment - it is never returned to clients, committed, or logged.
export const TRIAL_SCANS_PER_ACCOUNT = 3
export const TRIAL_SCANS_PER_IP_PER_DAY = 9

export function migrateTrial(db: Database.Database): void {
  // the free-scans count reads the budget ledger too (TRIAL_USED_SQL joins trial_reservations), so a store set up with the trial tables has it
  migrateTrialBudget(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS trial_scans (
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS trial_scans_tenant ON trial_scans (tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS trial_scans_ip ON trial_scans (ip_hash, created_at);
  `)
}

export interface OperatorKey { vendor: 'anthropic'; key: string }

// The shared key that funds trial scans. Absent means the trial is off and keyless
// accounts behave exactly as before (asked for their own key up front).
export function operatorKey(env: NodeJS.ProcessEnv = process.env): OperatorKey | null {
  const key = env.DAZL_TRIAL_ANTHROPIC_KEY?.trim()
  return key ? { vendor: 'anthropic', key } : null
}

// Raw IPs are never stored: the throttle works on a fixed-salt hash, which is enough to
// count "scans from the same network today" without keeping anyone's address around.
export const ipHash = (ip: string): string =>
  createHash('sha256').update(`dazl-trial-v1:${ip}`).digest('hex')

export type TrialDeny = 'not_configured' | 'account_cap' | 'ip_throttle'
export interface TrialState { funded: boolean; reason?: TrialDeny; used: number; remaining: number }

// A trial scan keeps its slot once it could have cost dazl money: a failed scan that reserved any paid step is one of
// the three, like a cancelled one (provider work may already have run on the operator key). Only a scan that failed
// before any cost (no spend reserved) gives the slot back, and so does a scan that STOPPED AFTER AN INTERRUPTION
// (failed accounting_uncertain) once its run has settled, and so does a free scan that stopped at its spending limit before finding any company (done trial_budget_reached, 0 candidates): the person got nothing (owner decisions 2026-11-11). Admission
// enforces the same count under its lock (lib/billing/trial-budget.ts releasedBeforeCost, pinned equal by
// test/trial-interrupted-attempt.test.ts); this one drives the free-scans counter and the first check.
const TRIAL_USED_SQL = `SELECT count(*) AS n FROM trial_scans t JOIN scan_jobs j ON j.id = t.job_id
     LEFT JOIN trial_reservations r ON r.job_id = j.id AND r.tenant_id = t.tenant_id AND r.kind = 'scan'
     WHERE t.tenant_id = ? AND (j.status != 'failed' OR j.error = 'cancelled' OR COALESCE(j.spend_reserved_usd, 0) > 0)
       AND NOT (j.status = 'failed' AND j.error = 'accounting_uncertain' AND r.settled_at IS NOT NULL AND r.settled_attempt = j.attempts)
       AND NOT (j.status = 'done' AND COALESCE(j.error, '') = 'trial_budget_reached' AND COALESCE(j.candidates, -1) = 0 AND r.settled_at IS NOT NULL AND r.settled_attempt = j.attempts)`
const TRIAL_IP_SQL = 'SELECT count(*) AS n FROM trial_scans WHERE ip_hash = ? AND created_at >= ?'
const dayStartS = (now: Date) => Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000)

// The decision, given the two counts; ipUsed is only read when the account is under its cap.
// exempt (#1579, DAZL_TRIAL_QA_EXEMPT in lib/billing/trial-budget.ts): the operator's acceptance account has no per-account count to
// run out of, so it is never refused account_cap and its counter always shows the full allowance; the per-network throttle still applies.
function trialDecision(used: number, ipUsed: () => number, exempt = false): TrialState {
  if (!exempt && used >= TRIAL_SCANS_PER_ACCOUNT) return { funded: false, reason: 'account_cap', used, remaining: 0 }
  const remaining = exempt ? TRIAL_SCANS_PER_ACCOUNT : TRIAL_SCANS_PER_ACCOUNT - used
  if (ipUsed() >= TRIAL_SCANS_PER_IP_PER_DAY) return { funded: false, reason: 'ip_throttle', used, remaining }
  return { funded: true, used, remaining }
}

// The exempt check for the synchronous store handle: the account's address is read from the same store. No query while the switch is
// unset; an account that cannot be read is not exempt.
function qaExemptSync(db: Database.Database, tenantId: string, env: NodeJS.ProcessEnv): boolean {
  if (!(env.DAZL_TRIAL_QA_EXEMPT ?? '').trim()) return false
  try {
    const email = (db.prepare('SELECT email FROM users WHERE id = ?').get(tenantId) as { email?: unknown } | undefined)?.email
    return typeof email === 'string' && trialQaExempt(email, env)
  } catch { return false }
}

export function trialStatus(db: Database.Database, tenantId: string, ip: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): TrialState {
  if (!operatorKey(env)) return { funded: false, reason: 'not_configured', used: 0, remaining: 0 }
  const used = (db.prepare(TRIAL_USED_SQL).get(tenantId) as { n: number }).n
  return trialDecision(used, () => (db.prepare(TRIAL_IP_SQL).get(ipHash(ip || 'unknown'), dayStartS(now)) as { n: number }).n, qaExemptSync(db, tenantId, env))
}

// trialStatus on the Db layer (SQLite or Postgres): the same counts and the same decision.
export async function readTrialStatus(db: Db, tenantId: string, ip: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<TrialState> {
  if (!operatorKey(env)) return { funded: false, reason: 'not_configured', used: 0, remaining: 0 }
  const used = Number((await db.get<{ n: number }>(TRIAL_USED_SQL, [tenantId]))!.n)
  const exempt = await trialQaExemptAccount(db, tenantId, env)
  const ipUsed = used >= TRIAL_SCANS_PER_ACCOUNT && !exempt ? 0 : Number((await db.get<{ n: number }>(TRIAL_IP_SQL, [ipHash(ip || 'unknown'), dayStartS(now)]))!.n)
  const state = trialDecision(used, () => ipUsed, exempt)
  if (exempt) return state
  // #1095: an account without Google has one free scan, not three; the counter says so (admission enforces it, lib/billing/trial-budget.ts)
  // Past that one, nothing changes here: the refusal (google_required) and its Link Google step speak, as they did before.
  const allowance = state.remaining > 0 ? await trialScanAllowance(db, tenantId, env) : TRIAL_SCANS_PER_ACCOUNT
  return used < allowance ? { ...state, remaining: Math.min(state.remaining, allowance - used) } : state
}

export function recordTrialScan(db: Database.Database, tenantId: string, jobId: string, ip: string): void {
  db.prepare('INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, ?)').run(tenantId, jobId, ipHash(ip || 'unknown'))
}
