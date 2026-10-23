import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, cancelJob, getJob, reapStaleJobs } from '../lib/scan/store.ts'

function setup() { const db = new Database(':memory:'); migrateScan(db); return db }
const status = (db: Database.Database, id: string) => db.prepare('SELECT status,error,attempts,claimed_at FROM scan_jobs WHERE id=?').get(id) as { status: string; error: string | null; attempts: number; claimed_at: number | null }

test('cancel a pending job: terminal failed/cancelled, never claimable again', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  assert.deepEqual(cancelJob(db, 'A', id), { ok: true, was_running: false })
  assert.equal(status(db, id).status, 'failed'); assert.equal(status(db, id).error, 'cancelled')
  assert.equal(db.prepare("UPDATE scan_jobs SET status='running' WHERE id=? AND status='pending'").run(id).changes, 0)
})

test('cancel a running job fences late runner writes and the stale reaper', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id=?").run(id)
  assert.deepEqual(cancelJob(db, 'A', id), { ok: true, was_running: true })
  // the runner's late finish/lead insert for attempt 1 is rejected
  assert.equal(db.prepare("SELECT 1 FROM scan_jobs WHERE id=? AND status='running' AND attempts=1").get(id), undefined)
  assert.throws(() => db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES('l1',?,'c','s','https://x.test/')").run(id), /running job/)
  reapStaleJobs(db)
  assert.equal(status(db, id).status, 'failed'); assert.equal(status(db, id).error, 'cancelled')
  assert.equal(getJob(db, 'A', id)?.attempts, 1)
})

test('tenant isolation, finished jobs, and double cancel', () => {
  const db = setup(); const id = createJob(db, 'A', { business_name: 'x', industry: 'i', location: 'l' })
  assert.deepEqual(cancelJob(db, 'B', id), { ok: false, reason: 'not_found' })
  assert.equal(status(db, id).status, 'pending')
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id); db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(id)
  assert.deepEqual(cancelJob(db, 'A', id), { ok: false, reason: 'already_finished' })
  const id2 = createJob(db, 'A', { business_name: 'y', industry: 'i', location: 'l' })
  assert.equal(cancelJob(db, 'A', id2).ok, true)
  assert.deepEqual(cancelJob(db, 'A', id2), { ok: false, reason: 'already_finished' })
})
