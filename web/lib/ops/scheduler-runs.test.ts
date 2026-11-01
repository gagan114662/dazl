import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateSchedulerRuns, recordProgress, tenantFreshness } from './scheduler-runs.ts'

// #411 reviewer gap: first-touch outcomes were folded into run counters because scheduler_progress.kind's CHECK
// predated the kind; per-tenant freshness could not see a failing first-touch-only tenant.

// tenantFreshness's due-work scan joins these; empty stand-ins keep this test scoped to scheduler progress.
const DUE_TABLES = `CREATE TABLE sequences (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, to_email TEXT NOT NULL, message_id TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE outreach_messages (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, sent_at INTEGER);
CREATE TABLE sequence_steps (tenant_id TEXT NOT NULL, sequence_id TEXT NOT NULL, step INTEGER NOT NULL, status TEXT NOT NULL);`

// A recently completed tick keeps the scheduler itself out of the reason list, so tests assert the tenant-level state.
const OK_RUN = `INSERT INTO scheduler_runs (id, started_at, finished_at, status, lease_owner, lease_generation) VALUES ('r0', 190, 199, 'ok', 'test', 1)`

const OLD_DDL = `CREATE TABLE scheduler_progress (
      tenant_id            TEXT NOT NULL,
      kind                 TEXT NOT NULL CHECK (kind IN ('reply_sync','followups','sequences')),
      last_attempt_at      INTEGER NOT NULL,
      last_success_at      INTEGER,
      last_error           TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
      last_outcome         TEXT NOT NULL DEFAULT 'success' CHECK (last_outcome IN ('success','hold','failure')),
      last_hold            TEXT CHECK (last_hold IS NULL OR length(last_hold) <= 40),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_run_id          TEXT,
      PRIMARY KEY (tenant_id, kind)
    )`

test('migration rebuilds a pre-first_touch store, carrying rows verbatim', async () => {
  const db = new Database(':memory:')
  db.exec(OLD_DDL)
  db.prepare(`INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, consecutive_failures) VALUES (?, ?, ?, ?, ?)`).run('t1', 'reply_sync', 100, 100, 0)
  db.prepare(`INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, consecutive_failures, last_outcome, last_hold) VALUES (?, ?, ?, ?, ?, 'hold', 'daily_cap')`).run('t2', 'sequences', 90, null, 0)

  migrateSchedulerRuns(db)

  assert.deepEqual(db.prepare('SELECT kind, last_attempt_at, consecutive_failures, last_outcome, last_hold FROM scheduler_progress WHERE tenant_id = ?').all('t1'),
    [{ kind: 'reply_sync', last_attempt_at: 100, consecutive_failures: 0, last_outcome: 'success', last_hold: null }])
  assert.deepEqual(db.prepare('SELECT kind, last_hold FROM scheduler_progress WHERE tenant_id = ?').all('t2'),
    [{ kind: 'sequences', last_hold: 'daily_cap' }])
  // The widened CHECK accepts first_touch; recordProgress writes it.
  await recordProgress(db, 'run1', 't1', 'first_touch', { outcome: 'success' }, 200)
  assert.equal((db.prepare(`SELECT kind FROM scheduler_progress WHERE tenant_id = 't1' AND kind = 'first_touch'`).get() as { kind: string }).kind, 'first_touch')
  // Idempotent: a second migration sees the new DDL and rebuilds nothing.
  migrateSchedulerRuns(db)
  assert.equal((db.prepare(`SELECT count(*) AS n FROM scheduler_progress`).get() as { n: number }).n, 3)
})

test('a fresh store records first_touch progress directly', async () => {
  const db = new Database(':memory:')
  migrateSchedulerRuns(db)
  db.exec(DUE_TABLES)
  db.prepare(OK_RUN).run()
  await recordProgress(db, 'run1', 't1', 'first_touch', { outcome: 'hold', reason: 'daily_cap' }, 200)
  const f = await tenantFreshness(db, 't1', 200)
  assert.equal(f.state, 'held')
  assert.deepEqual(f.holds, ['first_touch:daily_cap'])
  assert.deepEqual(f.work.map(w => w.kind), ['first_touch'])
})

test('three consecutive first-touch failures block the tenant, visibly', async () => {
  const db = new Database(':memory:')
  migrateSchedulerRuns(db)
  db.exec(DUE_TABLES)
  db.prepare(OK_RUN).run()
  for (let i = 1; i <= 3; i++) await recordProgress(db, `run${i}`, 't1', 'first_touch', { outcome: 'failure', error: new Error('gmail_unavailable') }, 100 + i)
  const f = await tenantFreshness(db, 't1', 200)
  assert.equal(f.state, 'blocked')
  assert.ok(f.reasons.includes('first_touch_failing'))
  // A first-touch success clears it.
  await recordProgress(db, 'run4', 't1', 'first_touch', { outcome: 'success' }, 200)
  assert.equal((await tenantFreshness(db, 't1', 300)).state, 'healthy')
})
