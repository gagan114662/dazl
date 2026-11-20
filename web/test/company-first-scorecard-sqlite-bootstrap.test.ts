import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createQueryJob, migrateScan, reapStaleJobs } from '../lib/scan/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'

test('standalone scan bootstrap allows ordinary recovery, DDL, and later full bootstrap', () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db)
    const job = createQueryJob(db, 'owner', {query: 'find local suppliers'})
    db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id=?").run(job)
    reapStaleJobs(db)
    assert.deepEqual(db.prepare("SELECT status, attempts FROM scan_jobs WHERE id=?").get(job), {status:'pending', attempts:1})
    db.exec("ALTER TABLE scan_jobs ADD COLUMN historical_extension TEXT")
    db.exec("ALTER TABLE scan_jobs RENAME COLUMN historical_extension TO restored_extension")
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name GLOB 'company_scorecard_*'").pluck().get(), 0)

    migrateAllSqlite(db)
    migrateScan(db)
    migrateAllSqlite(db)
    for (const name of ['marker_immutable','dispatch_stamp','no_handback'])
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").pluck().get('company_scorecard_'+name), 1)
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
    assert.throws(() => db.prepare("UPDATE scan_jobs SET company_scorecard_claim_nonce=? WHERE id=?").run('a'.repeat(64), job),
      /scorecard marker immutable/)
    assert.throws(() => db.prepare("UPDATE scan_jobs SET company_scorecard_dispatch_started_at=1, company_scorecard_dispatch_release=? WHERE id=?").run('b'.repeat(40), job),
      /scorecard dispatch stamp immutable/)
  } finally {
    db.close()
  }
})
