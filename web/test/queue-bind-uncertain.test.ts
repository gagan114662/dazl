// #594: the queue bind and the reaper share ONE rule for unsettled (reserved, possibly billed) spend calls: ANY attempt's
// reserved row blocks the re-bind and finalizes the stale job accounting_uncertain - an unsettled call of a dead EARLIER
// attempt may have been billed, so re-running it could double-charge. (Mutation: restoring `c.attempt = scan_jobs.attempts`
// on either statement lets the earlier-attempt case bind and re-run - this file turns red.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateScan, createJob, parkPendingReservedJobs, reapStaleRunningJobs } from '../lib/scan/store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'
import { migrateScanSpendCap } from '../lib/scan/spend-cap.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { kickQueueRunner, type ScanExecutor } from '../lib/scan/queue-runner.ts'

const LEASE = 1000
function setup(): { db: Database.Database; id: string; stale: number } {
  const db = new Database(':memory:')
  migrateScan(db)
  migrateScanSpendCap(db)
  migrateKeys(db) // syncPendingScansToQueue reads tenant_llm_keys
  const id = createJob(db, 'A', { business_name: 'Biz', industry: 'software', location: 'Toronto' })
  const stale = Math.floor(Date.now() / 1000) - 100000 // far older than the lease: a dead attempt's row
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 2, claimed_at = ?, funded_by = 'trial' WHERE id = ?").run(stale, id)
  return { db, id, stale }
}
const neverRun: ScanExecutor = async () => { throw new Error('executor must not run: a possibly-billed attempt is never re-run') }

test('queue bind: a stale running job whose EARLIER attempt left a reserved call finalizes accounting_uncertain, never re-runs', async () => {
  const { db, id } = setup()
  db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('c1', 'A', ?, 1, 'llm.anthropic', 0.05, 'reserved', 1)").run(id)
  await kickQueueRunner(db, {} as never, neverRun, { leaseSeconds: LEASE })
  const j = db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number }
  assert.deepEqual(j, { status: 'failed', error: 'accounting_uncertain', attempts: 2 })
})

test('queue bind: a stale running job with NO reserved call binds and re-runs (control)', async () => {
  const { db, id } = setup()
  let ran = 0
  const run: ScanExecutor = async (d, job) => { ran++; d.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), job.id); return 'done' }
  await kickQueueRunner(db, {} as never, run, { leaseSeconds: LEASE })
  assert.equal(ran, 1, 'the control job bound and ran')
  const j = db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number }
  assert.equal(j.attempts, 3, 'the bind incremented the attempt')
})

// A PENDING row with a reserved call is the pre-#594 reaper's legacy shape (it reset to pending regardless of
// reservations). It must end closed - never bind, never re-bill. (Mutation: scoping NOT EXISTS to the running branch
// lets this bind and re-run - red.)
test('queue bind: a PENDING job with a reserved call (pre-#594 shape) finalizes accounting_uncertain, never re-runs', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateScanSpendCap(db); migrateKeys(db)
  const id = createJob(db, 'A', { business_name: 'Biz', industry: 'software', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'pending', attempts = 1, claimed_at = NULL, funded_by = 'trial' WHERE id = ?").run(id)
  db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('c1', 'A', ?, 1, 'llm.anthropic', 0.05, 'reserved', 1)").run(id)
  await kickQueueRunner(db, {} as never, neverRun, { leaseSeconds: LEASE })
  const j = db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number }
  assert.deepEqual(j, { status: 'failed', error: 'accounting_uncertain', attempts: 1 }, 'no bind, no fresh attempt, no re-bill')
})

// The two-step reaper's PARKED shape: a pending+reserved row is first moved to running with claimed_at = 0 and NO
// attempt bump, then the main statement fails it accounting_uncertain. claimed_at = 0 is infinitely stale, so the
// queue bind's stale-running branch MATCHES it - only the any-attempt NOT EXISTS reserved guard stops the bind. The
// legacy claim (claimKeyedJob) only takes status='pending', so it never touches the parked row either. Pin both
// claim paths against a row parked by the PRODUCTION park step, claimed by a SECOND connection between the park and the
// finalize - the reviewer's two-step claimed_at=0 production-interleave question (a hand-seeded row proves nothing).
test('queue bind: a row parked by the PRODUCTION park step is taken by NEITHER claim path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qbind-'))
  const file = join(dir, 't.db')
  const db = new Database(file)
  migrateScan(db); migrateScanSpendCap(db); migrateKeys(db)
  const id = createJob(db, 'A', { business_name: 'Biz', industry: 'software', location: 'Toronto' }) // pending, attempts 0
  db.prepare("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('c1', 'A', ?, 0, 'llm.anthropic', 0.05, 'reserved', 1)").run(id)
  parkPendingReservedJobs(db) // production step 1 creates the parked shape: running, claimed_at = 0, attempts unchanged
  const parked = db.prepare('SELECT status, attempts, claimed_at FROM scan_jobs WHERE id = ?').get(id) as { status: string; attempts: number; claimed_at: number }
  assert.deepEqual(parked, { status: 'running', attempts: 0, claimed_at: 0 }, 'the production park: legal running step, no attempt bump, claimed_at older than any cutoff')
  const conn2 = new Database(file) // a second connection, as a concurrent worker process would hold
  try {
    assert.equal(claimKeyedJob(conn2), null, 'second connection: the legacy claim only takes pending rows - the parked row is never legacy-claimed')
    await kickQueueRunner(conn2, {} as never, neverRun, { leaseSeconds: LEASE }) // second connection: the queue bind guard blocks, then finalizes the parked row closed
  } finally { conn2.close() }
  reapStaleRunningJobs(db) // production step 2: nothing left to do - the row is already closed
  const j = db.prepare('SELECT status, error, attempts FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number }
  assert.deepEqual(j, { status: 'failed', error: 'accounting_uncertain', attempts: 0 }, 'the parked row ends closed: no fresh attempt, no executor run, no re-bill')
  db.close(); rmSync(dir, { recursive: true, force: true }) // the temp file db leaves nothing behind
})

test('queue bind: a pending job with NO reserved call binds and runs (control)', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateScanSpendCap(db); migrateKeys(db)
  const id = createJob(db, 'A', { business_name: 'Biz', industry: 'software', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'pending', funded_by = 'trial' WHERE id = ?").run(id)
  let ran = 0
  const run: ScanExecutor = async (d, job) => { ran++; d.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), job.id); return 'done' }
  await kickQueueRunner(db, {} as never, run, { leaseSeconds: LEASE })
  assert.equal(ran, 1, 'the pending control bound and ran')
})
