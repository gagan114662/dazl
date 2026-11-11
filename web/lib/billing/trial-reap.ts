// A trial scan finalized by a stale-job reaper (its worker died: failed accounting_uncertain / timeout, lib/scan/store*.ts, lib/queue/scan-claimer.ts,
// lib/scan/queue-runner.ts, lib/db/leads-read-pg.ts) never reaches the runner's last step, so its reservation was never settled: it kept a free scan
// forever and counted its full reserve toward every later day. This settles such reservations at the job's final attempt, keeping the scan's RECORDED
// spend (settled rows cost what scan_jobs.spend_reserved_usd says, never less than recorded). Idempotent, portable SQL (epoch seconds are parameters).
// Only scan reservations of jobs that are already terminal failures; a running, queued or done scan is untouched.
export const SETTLE_REAPED_TRIAL_SQL = `UPDATE trial_reservations SET settled_at = ?, settled_attempt = (SELECT j.attempts FROM scan_jobs j WHERE j.id = trial_reservations.job_id)
  WHERE kind = 'scan' AND settled_at IS NULL AND job_id IN (SELECT id FROM scan_jobs WHERE status = 'failed' AND error IN ('accounting_uncertain', 'timeout'))`
type SyncDb = { prepare(sql: string): { run(...a: unknown[]): unknown } }
type AsyncDb = { run(sql: string, p?: unknown[]): Promise<unknown> }
type PgQ = { query(sql: string, p?: unknown[]): Promise<unknown> }
const nowS = () => Math.floor(Date.now() / 1000)
export function settleReapedTrialSync(db: SyncDb, now = nowS()): void { try { db.prepare(SETTLE_REAPED_TRIAL_SQL).run(now) } catch { /* a store without the trial table: nothing to settle */ } }
export async function settleReapedTrial(db: AsyncDb, now = nowS()): Promise<void> { try { await db.run(SETTLE_REAPED_TRIAL_SQL, [now]) } catch { /* same */ } }
export async function settleReapedTrialPg(pg: PgQ, now = nowS()): Promise<void> { try { await pg.query(SETTLE_REAPED_TRIAL_SQL.replace('settled_at = ?', 'settled_at = $1'), [now]) } catch { /* same */ } }
