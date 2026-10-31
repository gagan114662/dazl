import { createHash } from 'node:crypto'
import type { Db } from '../db/client.ts'
import type Database from 'better-sqlite3'

// Free trial: a few scans per new account run on the server's shared operator key, so a new
// user can see real results before adding their own AI key. Abuse limits sit on top:
// a hard per-account cap and a per-IP daily throttle. The operator key lives only in the
// server environment - it is never returned to clients, committed, or logged.
export const TRIAL_SCANS_PER_ACCOUNT = 3
export const TRIAL_SCANS_PER_IP_PER_DAY = 9

export function migrateTrial(db: Database.Database): void {
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
// before any cost (no spend reserved) gives the slot back. Admission enforces the same count under its lock
// (lib/billing/trial-budget.ts releasedBeforeCost); this one drives the free-scans counter and the first check.
const TRIAL_USED_SQL = `SELECT count(*) AS n FROM trial_scans t JOIN scan_jobs j ON j.id = t.job_id
     WHERE t.tenant_id = ? AND (j.status != 'failed' OR j.error = 'cancelled' OR COALESCE(j.spend_reserved_usd, 0) > 0)`
const TRIAL_IP_SQL = 'SELECT count(*) AS n FROM trial_scans WHERE ip_hash = ? AND created_at >= ?'
const dayStartS = (now: Date) => Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000)

// The decision, given the two counts; ipUsed is only read when the account is under its cap.
function trialDecision(used: number, ipUsed: () => number): TrialState {
  if (used >= TRIAL_SCANS_PER_ACCOUNT) return { funded: false, reason: 'account_cap', used, remaining: 0 }
  if (ipUsed() >= TRIAL_SCANS_PER_IP_PER_DAY) return { funded: false, reason: 'ip_throttle', used, remaining: TRIAL_SCANS_PER_ACCOUNT - used }
  return { funded: true, used, remaining: TRIAL_SCANS_PER_ACCOUNT - used }
}

export function trialStatus(db: Database.Database, tenantId: string, ip: string, now = new Date()): TrialState {
  if (!operatorKey()) return { funded: false, reason: 'not_configured', used: 0, remaining: 0 }
  const used = (db.prepare(TRIAL_USED_SQL).get(tenantId) as { n: number }).n
  return trialDecision(used, () => (db.prepare(TRIAL_IP_SQL).get(ipHash(ip || 'unknown'), dayStartS(now)) as { n: number }).n)
}

// trialStatus on the Db layer (SQLite or Postgres): the same counts and the same decision.
export async function readTrialStatus(db: Db, tenantId: string, ip: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<TrialState> {
  if (!operatorKey(env)) return { funded: false, reason: 'not_configured', used: 0, remaining: 0 }
  const used = Number((await db.get<{ n: number }>(TRIAL_USED_SQL, [tenantId]))!.n)
  const ipUsed = used >= TRIAL_SCANS_PER_ACCOUNT ? 0 : Number((await db.get<{ n: number }>(TRIAL_IP_SQL, [ipHash(ip || 'unknown'), dayStartS(now)]))!.n)
  return trialDecision(used, () => ipUsed)
}

export function recordTrialScan(db: Database.Database, tenantId: string, jobId: string, ip: string): void {
  db.prepare('INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, ?)').run(tenantId, jobId, ipHash(ip || 'unknown'))
}
