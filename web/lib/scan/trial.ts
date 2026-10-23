import { createHash } from 'node:crypto'
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

export function trialStatus(db: Database.Database, tenantId: string, ip: string, now = new Date()): TrialState {
  if (!operatorKey()) return { funded: false, reason: 'not_configured', used: 0, remaining: 0 }
  // Genuinely failed scans refund the slot, same as the monthly quota: a scan that produced nothing
  // does not burn one of the three. A user-cancelled scan (error='cancelled') keeps its slot: provider
  // work may already have run and been billed to the operator key.
  const used = (db.prepare(
    `SELECT count(*) AS n FROM trial_scans t JOIN scan_jobs j ON j.id = t.job_id
     WHERE t.tenant_id = ? AND (j.status != 'failed' OR j.error = 'cancelled')`,
  ).get(tenantId) as { n: number }).n
  if (used >= TRIAL_SCANS_PER_ACCOUNT) return { funded: false, reason: 'account_cap', used, remaining: 0 }
  const dayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000)
  const ipUsed = (db.prepare(
    'SELECT count(*) AS n FROM trial_scans WHERE ip_hash = ? AND created_at >= ?',
  ).get(ipHash(ip || 'unknown'), dayStart) as { n: number }).n
  if (ipUsed >= TRIAL_SCANS_PER_IP_PER_DAY) return { funded: false, reason: 'ip_throttle', used, remaining: TRIAL_SCANS_PER_ACCOUNT - used }
  return { funded: true, used, remaining: TRIAL_SCANS_PER_ACCOUNT - used }
}

export function recordTrialScan(db: Database.Database, tenantId: string, jobId: string, ip: string): void {
  db.prepare('INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, ?)').run(tenantId, jobId, ipHash(ip || 'unknown'))
}
