import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateMonitors, createMonitor, listMonitors, runDueMonitors, collectMonitorResults, setMonitorEnabled, deleteMonitor, MONITOR_LIMITS } from '../lib/monitors.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { setPlan } from './helpers/plan-fixture.ts'
const dbs = new WeakMap<Database.Database, Db>()
const D = (db: Database.Database) => { let d = dbs.get(db); if (!d) dbs.set(db, d = sqliteDb(db)); return d }

const setup = () => { const db = new Database(':memory:'); migrateScan(db); migratePlans(db); migrateMonitors(db); return db }
// Leads can only be inserted while the job is running (trigger), then the job is marked done.
const insertLeads = (db: Database.Database, jobId: string, keys: string[]) => {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status) VALUES (?, 'u1', 'b', 'i', 'l', 'q', 'running')").run(jobId)
  for (const k of keys) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, dedup_key) VALUES (lower(hex(randomblob(12))), ?, 'n', 'c', 's', 'https://e.com', ?)").run(jobId, k)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
}

test('free plan: 2 monitors max, weekly minimum interval; pro: 10, daily', async () => {
  const db = setup()
  assert.ok('id' in (await createMonitor(D(db), 'u1', { query: 'robotics companies hiring sales' })))
  assert.ok('id' in (await createMonitor(D(db), 'u1', { query: 'fintech seed rounds in Europe' })))
  assert.deepEqual((await createMonitor(D(db), 'u1', { query: 'a third monitor query' })), { error: 'limit', limit: MONITOR_LIMITS.free.maxMonitors })
  assert.deepEqual((await createMonitor(D(db), 'u1', { query: 'another one here', intervalHours: 24 })), { error: 'interval', min: 168 })
  setPlan(db, 'u2', 'pro')
  assert.ok('id' in (await createMonitor(D(db), 'u2', { query: 'daily is fine on pro plans', intervalHours: 24 })))
})

test('due monitors create scan jobs and schedule the next run; quota exhaustion pauses the monitor', async () => {
  const db = setup()
  const r = (await createMonitor(D(db), 'u1', { query: 'robotics companies hiring sales' }))
  assert.ok('id' in r && typeof r.id === 'string')
  const jobs = (await runDueMonitors(D(db)))
  assert.equal(jobs.length, 1)
  const m = (await listMonitors(D(db), 'u1'))[0] as { next_run_at: number; last_run_at: number }
  assert.equal(m.next_run_at - m.last_run_at, 168 * 3600)
  assert.equal((db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = 'u1'").get() as { n: number }).n, 1)
  // 50 scans this month -> free quota gone -> the monitor pauses itself instead of failing.
  for (let i = 0; i < 49; i++) db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status) VALUES (lower(hex(randomblob(12))), 'u1', 'b', 'i', 'l', 'q', 'done')").run()
  db.prepare("UPDATE monitors SET next_run_at = 1").run()
  assert.equal((await runDueMonitors(D(db))).length, 0)
  const paused = (await listMonitors(D(db), 'u1'))[0] as { enabled: number; paused_reason: string }
  assert.equal(paused.enabled, 0)
  assert.equal(paused.paused_reason, 'quota')
})

test('collectMonitorResults counts only leads the monitor has not surfaced before', async () => {
  const db = setup()
  const r = (await createMonitor(D(db), 'u1', { query: 'robotics companies hiring sales' }))
  const id = (r as { id: string }).id
  await runDueMonitors(D(db))
  const jobId = (db.prepare("SELECT job_id FROM monitor_runs").get() as { job_id: string }).job_id
  db.prepare("DELETE FROM scan_jobs").run() // drop the queued row; insertLeads recreates it done
  insertLeads(db, jobId, ['acme', 'beta'])
  assert.equal((await collectMonitorResults(D(db))), 1)
  assert.equal((db.prepare('SELECT new_count FROM monitor_runs').get() as { new_count: number }).new_count, 2)
  // Second run with one repeat and one new company: only the new one counts.
  db.prepare("UPDATE monitors SET next_run_at = 1").run()
  await runDueMonitors(D(db))
  const job2 = (db.prepare("SELECT job_id FROM monitor_runs ORDER BY rowid DESC LIMIT 1").get() as { job_id: string }).job_id
  db.prepare("DELETE FROM scan_jobs").run()
  insertLeads(db, job2, ['acme', 'gamma'])
  await collectMonitorResults(D(db))
  assert.equal((db.prepare('SELECT new_count FROM monitor_runs WHERE job_id = ?').get(job2) as { new_count: number }).new_count, 1)
})

test('enable/disable and delete are owner-scoped', async () => {
  const db = setup()
  const id = ((await createMonitor(D(db), 'u1', { query: 'robotics companies hiring sales' })) as { id: string }).id
  assert.equal((await setMonitorEnabled(D(db), 'u1', id, false)), true)
  // the same state again is not a change (decided in the statement; the audit trail records only flips)
  assert.equal((await setMonitorEnabled(D(db), 'u1', id, false)), false)
  assert.equal((await setMonitorEnabled(D(db), 'u1', id, true)), true)
  assert.equal((await setMonitorEnabled(D(db), 'u1', id, false)), true)
  assert.equal((await setMonitorEnabled(D(db), 'u2', id, true)), false)
  assert.equal((await deleteMonitor(D(db), 'u2', id)), false)
  assert.equal((await deleteMonitor(D(db), 'u1', id)), true)
})
