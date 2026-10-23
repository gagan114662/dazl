import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, createQueryJob } from '../lib/scan/store.ts'
import { primarySignalKind } from '../lib/scan/score.ts'
import { sourceKind } from '../lib/scan/runner.ts'
import { migrateMonitors } from '../lib/monitors.ts'

const setup = () => { const db = new Database(':memory:'); migrateScan(db); migrateMonitors(db); return db }

test('primarySignalKind: first valid grader signal wins, anything else stays untagged', () => {
  assert.equal(primarySignalKind('["hiring","raised_funding"]'), 'hiring')
  assert.equal(primarySignalKind('["nonsense","raised_funding"]'), 'raised_funding')
  assert.equal(primarySignalKind('["nonsense"]'), null)
  assert.equal(primarySignalKind('not json'), null)
  assert.equal(primarySignalKind('{"a":1}'), null)
  assert.equal(primarySignalKind(null), null)
  assert.equal(primarySignalKind('[]'), null)
})

test('sourceKind: watch and csv jobs beat the query default', () => {
  const base = { id: 'j', user_id: 'u', business_name: 'b', industry: 'i', location: 'l', attempts: 1 }
  assert.equal(sourceKind({ ...base }), 'query')
  assert.equal(sourceKind({ ...base, watch_id: 'w1' }), 'watch')
  assert.equal(sourceKind({ ...base, csv_domain: 'acme.com' }), 'csv')
})

test('migration backfills kinds for pre-existing rows and leaves unknowns NULL', () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateMonitors(db)
  // Rows as written before the tag columns existed: no signal_kind/source_kind values.
  const job = createQueryJob(db, 'u1', { query: 'robotics companies hiring sales' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, signals) VALUES ('l1', ?, 'n', 'c', 's', 'https://e.com', '[\"hiring\"]')").run(job)
  const watchJob = createQueryJob(db, 'u1', { query: 'watch this space', watchId: 'w1' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(watchJob)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('l2', ?, 'n', 'c', 's', 'https://e.com')").run(watchJob)
  db.prepare("INSERT INTO monitors (id, user_id, query, interval_hours) VALUES ('m1', 'u1', 'robotics hiring', 168)").run()
  db.prepare("INSERT INTO monitor_runs (id, monitor_id, job_id) VALUES ('mr1', 'm1', ?)").run(job)
  migrateScan(db) // idempotent re-run performs the backfill
  const l1 = db.prepare('SELECT signal_kind, source_kind FROM leads WHERE id = ?').get('l1') as { signal_kind: string; source_kind: string }
  const l2 = db.prepare('SELECT signal_kind, source_kind FROM leads WHERE id = ?').get('l2') as { signal_kind: string | null; source_kind: string }
  assert.equal(l1.signal_kind, 'hiring')
  assert.equal(l1.source_kind, 'monitor') // monitor run linkage beats the query default
  assert.equal(l2.source_kind, 'watch')
  assert.equal(l2.signal_kind, null)
})

test('fixture company rows backfill to source_kind test by job-level fixture provenance, never by name', () => {
  const db = new Database(':memory:')
  migrateScan(db)
  // The real fixture inserter (lib/outreach/test-fixture.ts) writes its job with
  // industry/location 'test only'; the backfill keys on that job-level marker.
  const job = createJob(db, 'u1', { business_name: 'dazl sequence test fixture (test only)', industry: 'test only', location: 'test only' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES ('f1', ?, 'dazl sequence test fixture (test only)', 's', 'https://e.com')").run(job)
  // The identical company name on a NORMAL job is a genuine row and stays real.
  const normal = createJob(db, 'u1', { business_name: 'b', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(normal)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES ('f2', ?, 'dazl sequence test fixture (test only)', 's', 'https://e.com')").run(normal)
  migrateScan(db)
  assert.equal((db.prepare('SELECT source_kind FROM leads WHERE id = ?').get('f1') as { source_kind: string }).source_kind, 'test')
  assert.notEqual((db.prepare('SELECT source_kind FROM leads WHERE id = ?').get('f2') as { source_kind: string | null }).source_kind, 'test')
})
