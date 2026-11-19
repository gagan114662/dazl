import type Database from 'better-sqlite3'
import { settlePinnedTrialReservation } from '../billing/trial-budget.ts'
import { sqliteDb } from '../db/client.ts'
import { failCrashedJob } from './crash.ts'
import { qaPinnedLocalJob } from './qa-provider-policy.ts'
import { acquireSlot, releaseSlot, slotAvailable } from './run-slots.ts'
import { runJob, trackInFlight, type Job } from './runner.ts'

// Admission and the callback share a slot in the process, not a global queue.
export function reserveStrictLocalSlot(): (() => void) | null {
  if (!slotAvailable()) return null
  acquireSlot()
  let open = true
  return () => { if (open) { open = false; releaseSlot() } }
}

export async function runStrictLocalJob(db: Database.Database, job: Job): Promise<void> {
  if (!qaPinnedLocalJob(job.run_budget)) return
  let untrack: (() => void) | undefined
  try {
    const current = await sqliteDb(db).get("SELECT 1 FROM scan_jobs WHERE id=? AND user_id=? AND status='running' AND attempts=? AND run_budget=?",
      [job.id, job.user_id, job.attempts, job.run_budget ?? null])
    if (!current) return
    untrack = trackInFlight(job)
    await runJob(db, job)
  } catch (e) { failCrashedJob(db, job, e, 'scan-runner') }
  finally {
    try {
      if (job.funded_by === 'trial') await settlePinnedTrialReservation(db, job.user_id, job.id, job.attempts)
    } finally { untrack?.() }
  }
}
