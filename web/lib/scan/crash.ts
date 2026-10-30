// A scan run that crashed (an exception escaped runJob's own failure handling) is recorded through the scrubbed error
// monitor and its job is marked failed, so it does not sit in 'running' until the stale-lease reaper finds it.
// Fenced like finish(): only the attempt that crashed may fail its row (status 'running', same attempts), so a crash
// arriving after a re-claim, a cancel or a finish changes nothing. If the store itself is failing the row stays as it
// is and the reaper remains the fallback.
import type Database from 'better-sqlite3'
import { captureError } from '../ops/errors.ts'

export function failCrashedJob(db: Database.Database, job: { id: string; user_id: string; attempts: number }, e: unknown, where: 'scan-runner' | 'queue-runner'): boolean {
  captureError(e, { source: 'worker', where, tenantId: job.user_id, ref: job.id })
  try {
    return db.prepare(
      `UPDATE scan_jobs SET status = 'failed', error = 'crashed', claimed_at = NULL, finished_at = CAST(strftime('%s','now') AS INTEGER)
       WHERE id = ? AND status = 'running' AND attempts = ?`,
    ).run(job.id, job.attempts).changes === 1
  } catch (e2) {
    captureError(e2, { source: 'worker', where, tenantId: job.user_id, ref: job.id })
    return false
  }
}
