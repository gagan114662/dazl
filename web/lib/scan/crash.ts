// A scan run that crashed (an exception escaped runJob's own failure handling) is recorded through the scrubbed error
// monitor and its job is marked failed, so it does not sit in 'running' until the stale-lease reaper finds it.
// Fenced like finish(): only the attempt that crashed may fail its row (status 'running', same attempts), so a crash
// arriving after a re-claim, a cancel or a finish changes nothing. If the store itself is failing the row stays as it
// is and the reaper remains the fallback.
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { captureError } from '../ops/errors.ts'

type CrashedJob = { id: string; user_id: string; attempts: number }
type CrashLocation = 'scan-runner' | 'queue-runner'

const FAIL_CRASH_SQL = `UPDATE scan_jobs SET status = 'failed', error = 'crashed', claimed_at = NULL, finished_at = ?
  WHERE id = ? AND user_id = ? AND status = 'running' AND attempts = ?`

export function failCrashedJob(db: Database.Database, job: CrashedJob, e: unknown, where: CrashLocation): boolean
export function failCrashedJob(db: Db, job: CrashedJob, e: unknown, where: CrashLocation): Promise<boolean>
export function failCrashedJob(db: Db | Database.Database, job: CrashedJob, e: unknown, where: CrashLocation): boolean | Promise<boolean> {
  const context = { source: 'worker' as const, where, tenantId: job.user_id, ref: job.id }
  captureError(e, context)
  const params = [Math.floor(Date.now() / 1000), job.id, job.user_id, job.attempts]
  const failedWrite = (error: unknown) => {
    captureError(error, context)
    return false
  }
  if ('kind' in db) return db.run(FAIL_CRASH_SQL, params).then(r => r.changes === 1, failedWrite)
  try {
    return db.prepare(FAIL_CRASH_SQL).run(...params).changes === 1
  } catch (error) { return failedWrite(error) }
}
