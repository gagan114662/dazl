// #1849: Leads > Past scans listed the same stopped 'GTA contractors' search twice, while Plays listed it once.
// listJobs has no join, so a duplicate card means two scan_jobs rows. Two rows are the same scan in substance only
// when everything the list shows about them is identical AND they were created in the same second (the
// double-record signature): those collapse to one, keeping the row that carries the leads. Two real runs of one
// search — even on the same day — both stay: each is its own billed record, and the card now shows the run time
// so they can be told apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateRunReport } from '../lib/scan/run-report.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'

const T0 = 1764110400 // a fixed Tuesday 09:00:00 UTC

function stoppedSearch(db: Database.Database, createdAt: number, query = 'GTA contractors', withLead = false) {
  const id = createJob(db, 'A', { business_name: 'x', industry: 'contractors', location: 'GTA' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(id) // the status guard requires the running step
  if (withLead) db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES (?, ?, 'Acme Contracting', 'Acme is hiring crews', 'https://example.com/acme')").run(`lead-${id}`, id) // leads only land on a running job
  db.prepare("UPDATE scan_jobs SET query = ?, status = 'done', created_at = ?, finished_at = ? WHERE id = ?")
    .run(query, createdAt, createdAt + 60, id)
  return id
}

test('#1849 a same-second duplicate of one stopped search lists once, keeping the row with the leads', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateRunReport(db)
  const real = stoppedSearch(db, T0, 'GTA contractors', true)
  const twin = stoppedSearch(db, T0)
  assert.ok(twin)
  const jobs = (await historyJobs(sqliteDb(db), 'A')).filter(j => j.query === 'GTA contractors')
  assert.equal(jobs.length, 1, 'the twin rows collapse to one Past scans card')
  assert.equal(jobs[0].id, real, 'the surviving card is the row that carries the leads')
  assert.equal(jobs[0].lead_count, 1)
})

test('#1849 two real runs of the same search, minutes apart, both list', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateRunReport(db)
  stoppedSearch(db, T0)
  stoppedSearch(db, T0 + 300)
  const jobs = (await historyJobs(sqliteDb(db), 'A')).filter(j => j.query === 'GTA contractors')
  assert.equal(jobs.length, 2, 'each run is its own billed record and stays listed')
  assert.deepEqual(jobs.map(j => j.created_at).sort(), [T0, T0 + 300], 'distinguishable by their run times')
})

test('#1849 different searches in the same second both list', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateRunReport(db)
  stoppedSearch(db, T0, 'GTA contractors')
  stoppedSearch(db, T0, 'GTA plumbers')
  const jobs = await historyJobs(sqliteDb(db), 'A')
  assert.equal(jobs.length, 2)
})
