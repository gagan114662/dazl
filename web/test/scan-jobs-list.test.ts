// listJobs powers the leads-page history list: a returning user must see their own
// past scans, newest first, with honest status and counts - and never another tenant's.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createJob, createQueryJob, listJobs, migrateScan } from '../lib/scan/store.ts'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const setup = () => {
  const db = new Database(':memory:')
  migrateScan(db)
  return db
}

test('listJobs returns only the tenant own jobs, newest first', () => {
  const db = setup()
  const a1 = createJob(db, A, { business_name: 'Acme', industry: 'saas', location: 'Toronto' })
  const a2 = createQueryJob(db, A, { query: 'crm admins hiring', icp: null })
  createJob(db, B, { business_name: 'OtherCo', industry: 'saas', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET created_at = created_at - 10 WHERE id = ?").run(a1) // a2 is newer
  const jobs = listJobs(db, A)
  assert.deepEqual(jobs.map(j => j.id), [a2, a1])
  assert.equal(jobs[0].query, 'crm admins hiring')
  assert.equal(jobs[1].business_name, 'Acme')
  assert.equal(listJobs(db, B).length, 1)
})

test('listJobs is empty for a tenant with no scans', () => {
  const db = setup()
  assert.deepEqual(listJobs(db, A), [])
})

test('listJobs carries status, error and lead_count honestly', () => {
  const db = setup()
  const done = createJob(db, A, { business_name: 'DoneCo', industry: 'saas', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(done)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES ('l1', ?, 'Pat', 'DoneCo', 'pat@done.co', 'hiring', 'https://done.co/jobs', 'quote', 80, 4, 4)").run(done)
  db.prepare("UPDATE scan_jobs SET status = 'done', candidates = 11, verified = 1, needs_review = 9, dropped = 1 WHERE id = ?").run(done)
  const failed = createJob(db, A, { business_name: 'FailCo', industry: 'saas', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(failed)
  db.prepare("UPDATE scan_jobs SET status = 'failed', error = 'no_candidates' WHERE id = ?").run(failed)
  const running = createJob(db, A, { business_name: 'RunCo', industry: 'saas', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(running)
  const byId = new Map(listJobs(db, A).map(j => [j.id, j]))
  assert.equal(byId.get(done)?.status, 'done')
  assert.equal(byId.get(done)?.lead_count, 1)
  assert.equal(byId.get(done)?.candidates, 11)
  assert.equal(byId.get(done)?.verified, 1)
  assert.equal(byId.get(done)?.needs_review, 9)
  assert.equal(byId.get(done)?.dropped, 1)
  assert.equal(byId.get(failed)?.status, 'failed')
  assert.equal(byId.get(failed)?.error, 'no_candidates')
  assert.equal(byId.get(failed)?.lead_count, 0)
  assert.equal(byId.get(running)?.status, 'running')
})

test('listJobs labels nothing: test_only marking lives at the route, business_name is preserved', () => {
  const db = setup()
  const fx = createJob(db, A, { business_name: 'dazl verification fixture (test only)', industry: 'test only', location: 'test only' })
  const jobs = listJobs(db, A)
  assert.equal(jobs[0].id, fx)
  assert.equal(jobs[0].business_name, 'dazl verification fixture (test only)')
  assert.ok(jobs[0].business_name.endsWith('(test only)'))
})

test('listJobs respects the limit', () => {
  const db = setup()
  for (let i = 0; i < 25; i++) createJob(db, A, { business_name: `Co${i}`, industry: 'saas', location: 'Toronto' })
  assert.equal(listJobs(db, A).length, 20)
  assert.equal(listJobs(db, A, 5).length, 5)
})
