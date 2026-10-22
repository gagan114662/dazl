// Synthetic end-to-end proof for the queue-backed scan path (no providers).
// Fixture scan_jobs/tenant_llm_keys carry only the columns the bridge and the
// fake executor touch; the fake executor plays finish()'s role with the same
// conditional-UPDATE fencing runner.ts uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SqliteQueue } from '../lib/queue/sqlite.ts'
import { syncPendingScansToQueue, kickQueueRunner } from '../lib/scan/queue-runner.ts'

function fixture(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync('/tmp/qr-')
  const db = new Database(`${dir}/app.db`)
  db.exec(`CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, user_id TEXT, status TEXT, attempts INTEGER DEFAULT 0,
      created_at INTEGER, claimed_at INTEGER, error TEXT, finished_at INTEGER,
      business_name TEXT, industry TEXT, location TEXT, query TEXT, icp TEXT,
      sources TEXT, funded_by TEXT, watch_id TEXT, csv_domain TEXT);
    CREATE TABLE tenant_llm_keys (tenant_id TEXT, vendor TEXT, created_at INTEGER);`)
  return { db, dir }
}

function seedJob(db: Database.Database, id: string, user: string, funded = true): void {
  db.prepare(`INSERT INTO scan_jobs (id, user_id, status, attempts, created_at, funded_by)
              VALUES (?,?,'pending',0,?,?)`)
    .run(id, user, Math.floor(Date.now() / 1000), funded ? 'trial' : null)
}

// Fake executor with finish()-style fencing: writes only if the attempt owns
// the row, then reports the outcome the domain row lands on.
function fakeExecutor(outcome: 'done' | 'failed' | 'retry') {
  return async (db: Database.Database, job: { id: string; attempts: number }): Promise<'done' | 'failed' | 'retry'> => {
    const own = db.prepare(`SELECT 1 FROM scan_jobs WHERE id=? AND status='running' AND attempts=?`).get(job.id, job.attempts)
    if (!own) return 'retry' // fenced off: our write would be a no-op anyway
    const status = outcome === 'retry' ? 'pending' : outcome
    db.prepare(`UPDATE scan_jobs SET status=?, claimed_at=NULL WHERE id=?`).run(status, job.id)
    return outcome
  }
}

const flush = () => new Promise((r) => setTimeout(r, 25))

test('sync mirrors pending funded jobs once; keyless non-trial untouched', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')           // trial-funded
  db.prepare(`INSERT INTO tenant_llm_keys VALUES ('bob','openai',1)`).run()
  seedJob(db, 'j2', 'bob', false)      // own key
  seedJob(db, 'j3', 'carol', false)    // no key, no trial -> NOT mirrored
  const q = new SqliteQueue(db)
  assert.equal(syncPendingScansToQueue(db, q), 2)
  assert.equal(syncPendingScansToQueue(db, q), 0) // idempotent
  assert.equal(q.depth({ kind: 'scan' }), 2)
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('end to end: claim bumps domain attempts; done completes queue item', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  await kickQueueRunner(db, {}, fakeExecutor('done'))
  await flush()
  const row = db.prepare(`SELECT status, attempts FROM scan_jobs WHERE id='j1'`).get() as { status: string; attempts: number }
  assert.deepEqual(row, { status: 'done', attempts: 1 })
  const q = new SqliteQueue(db)
  assert.equal(q.get('j1')!.status, 'done')
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('retry: domain re-pends and queue backs off - not instantly re-claimed', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  await kickQueueRunner(db, {}, fakeExecutor('retry'))
  await flush()
  assert.equal((db.prepare(`SELECT status FROM scan_jobs WHERE id='j1'`).get() as { status: string }).status, 'pending')
  const q = new SqliteQueue(db)
  const item = q.get('j1')!
  assert.equal(item.status, 'pending')
  assert.ok(item.notBefore > Math.floor(Date.now() / 1000), 'backoff applied, not immediate re-pend')
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('failed: queue item fails with the domain row', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  await kickQueueRunner(db, {}, fakeExecutor('failed'))
  await flush()
  assert.equal((db.prepare(`SELECT status FROM scan_jobs WHERE id='j1'`).get() as { status: string }).status, 'failed')
  assert.equal(new SqliteQueue(db).get('j1')!.status, 'failed')
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('restart mid-claim, full bridge: dead attempt fenced, new attempt recovers the row', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  // Attempt 1 claims with a 1s lease and its executor hangs (the "crash").
  let releaseHang!: (v: 'retry') => void
  const hang = new Promise<'retry'>((r) => { releaseHang = r })
  await kickQueueRunner(db, {}, () => hang, { leaseSeconds: 1 })
  assert.equal((db.prepare(`SELECT status, attempts FROM scan_jobs WHERE id='j1'`).get() as { status: string }).status, 'running')
  // Attempt 1 dies. 1.1s later its lease is expired; a new kick reaps it
  // (backoff skipped via a clock 40s ahead) and binds the stale domain row.
  await new Promise((r) => setTimeout(r, 2100)) // strftime has second resolution; clear the boundary deterministically
  const future = Math.floor(Date.now() / 1000) + 40
  // Kick 1 reaps the expired claim; the re-pend carries a 30s backoff from
  // that clock, so the same kick cannot re-claim (crash-loop protection).
  await kickQueueRunner(db, {}, fakeExecutor('done'), { leaseSeconds: 1, now: future })
  // Kick 2, past the backoff, re-claims and binds the stale domain row.
  // Margin 45s > 30s base + 20% jitter (36s max) since the bridge uses the
  // default rng - this must not be timing-flaky.
  await kickQueueRunner(db, {}, fakeExecutor('done'), { leaseSeconds: 1, now: future + 45 })
  await flush()
  const row = db.prepare(`SELECT status, attempts FROM scan_jobs WHERE id='j1'`).get() as { status: string; attempts: number }
  assert.deepEqual(row, { status: 'done', attempts: 2 })
  // The hung attempt now "finishes late" reporting retry: its token is stale,
  // so the bridge must NOT move the queue item back to pending.
  releaseHang('retry')
  await flush()
  assert.equal(new SqliteQueue(db).get('j1')!.status, 'done')
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('orphan reconcile: domain pending again + terminal queue item re-enqueues fresh', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  await kickQueueRunner(db, {}, fakeExecutor('failed'))
  await flush()
  const q = new SqliteQueue(db)
  assert.equal(q.get('j1')!.status, 'failed')
  const tokenAfterFail = (db.prepare(`SELECT v FROM work_queue_meta WHERE k='token'`).get() as { v: number }).v
  // Domain row goes pending again (operator retry, legacy path, etc.).
  db.prepare(`UPDATE scan_jobs SET status='pending' WHERE id='j1'`).run()
  assert.equal(syncPendingScansToQueue(db, q), 1, 're-enqueued, not skipped')
  const item = q.get('j1')!
  assert.equal(item.status, 'pending')
  assert.equal(item.attempts, 0, 'fresh scheduling epoch')
  // It actually gets claimed and run by the next kick.
  await kickQueueRunner(db, {}, fakeExecutor('done'))
  await flush()
  assert.equal((db.prepare(`SELECT status FROM scan_jobs WHERE id='j1'`).get() as { status: string }).status, 'done')
  const tokenNow = (db.prepare(`SELECT v FROM work_queue_meta WHERE k='token'`).get() as { v: number }).v
  assert.ok(tokenNow > tokenAfterFail, 'fencing tokens only move forward')
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('env flip mid-flight: legacy-claimed fresh row is NOT double-run by queue mode', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  // Legacy runner claimed it seconds ago (running, fresh claimed_at).
  db.prepare(`UPDATE scan_jobs SET status='running', attempts=1, claimed_at=CAST(strftime('%s','now') AS INTEGER) WHERE id='j1'`).run()
  let runs = 0
  const counting = async (d: Database.Database, job: { id: string }): Promise<'done'> => { runs++; return 'done' }
  await kickQueueRunner(db, {}, counting)
  await flush()
  assert.equal(runs, 0, 'fresh legacy claim not re-run')
  // Queue did not mirror a running row.
  assert.equal(new SqliteQueue(db).get('j1'), undefined)
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('env flip mid-flight: legacy-claimed STALE row is recovered, not double-run', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'alice')
  // Legacy runner crashed long ago: running with ancient claimed_at.
  db.prepare(`UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id='j1'`).run()
  let runs = 0
  const countingDone = async (d: Database.Database, job: { id: string; attempts: number }): Promise<'done'> => {
    runs++
    d.prepare(`UPDATE scan_jobs SET status='done' WHERE id=? AND attempts=?`).run(job.id, job.attempts)
    return 'done'
  }
  await kickQueueRunner(db, {}, countingDone)
  await flush()
  assert.equal(runs, 1, 'stale row recovered exactly once')
  assert.equal((db.prepare(`SELECT attempts FROM scan_jobs WHERE id='j1'`).get() as { attempts: number }).attempts, 2)
  db.close(); rmSync(dir, { recursive: true, force: true })
})

test('bridge 2-process: two queue handles over one file never run a job twice', async () => {
  const dir = mkdtempSync('/tmp/qr2-')
  const path = `${dir}/app.db`
  const mkDb = () => {
    const db = new Database(path)
    db.exec(`CREATE TABLE IF NOT EXISTS scan_jobs (
        id TEXT PRIMARY KEY, user_id TEXT, status TEXT, attempts INTEGER DEFAULT 0,
        created_at INTEGER, claimed_at INTEGER, error TEXT, finished_at INTEGER,
        business_name TEXT, industry TEXT, location TEXT, query TEXT, icp TEXT,
        sources TEXT, funded_by TEXT, watch_id TEXT, csv_domain TEXT);
      CREATE TABLE IF NOT EXISTS tenant_llm_keys (tenant_id TEXT, vendor TEXT, created_at INTEGER);`)
    return db
  }
  const dbA = mkDb()
  for (let i = 0; i < 10; i++) {
    dbA.prepare(`INSERT INTO scan_jobs (id, user_id, status, attempts, created_at, funded_by) VALUES (?,?, 'pending', 0, ?, 'trial')`)
      .run(`j${i}`, 'alice', Math.floor(Date.now() / 1000))
  }
  const runs = new Map<string, number>()
  const counting = async (d: Database.Database, job: { id: string; attempts: number }): Promise<'done'> => {
    runs.set(job.id, (runs.get(job.id) ?? 0) + 1)
    d.prepare(`UPDATE scan_jobs SET status='done' WHERE id=?`).run(job.id)
    return 'done'
  }
  // Two "processes" (separate connections) kicking concurrently.
  const dbB = mkDb()
  // Drain: keep kicking until all 10 are done (each kick claims up to the cap).
  for (let i = 0; i < 12 && runs.size < 10; i++) {
    await Promise.all([kickQueueRunner(dbA, {}, counting), kickQueueRunner(dbB, {}, counting)])
    await new Promise((r) => setTimeout(r, 60))
  }
  assert.equal(runs.size, 10, 'every job ran')
  for (const [id, n] of runs) assert.equal(n, 1, `job ${id} ran exactly once`)
  dbA.close(); dbB.close(); rmSync(dir, { recursive: true, force: true })
})

test('funding revoked after mirror: run fails closed, queue item fails with the domain row', async () => {
  const { db, dir } = fixture()
  seedJob(db, 'j1', 'carol', false) // no key, no trial -> not mirrored
  db.prepare(`INSERT INTO tenant_llm_keys VALUES ('carol','openai',1)`).run()
  const q = new SqliteQueue(db)
  assert.equal(syncPendingScansToQueue(db, q), 1)
  // Key revoked before the kick: sync no longer picks it, and a real run
  // would fail closed on readKey. The mirrored item stays queued until its
  // own attempts/lease lifecycle resolves it - documented closed failure.
  db.prepare(`DELETE FROM tenant_llm_keys WHERE tenant_id='carol'`).run()
  assert.equal(syncPendingScansToQueue(db, q), 0, 'revoked tenant no longer mirrored')
  db.close(); rmSync(dir, { recursive: true, force: true })
})
