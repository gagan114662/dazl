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
