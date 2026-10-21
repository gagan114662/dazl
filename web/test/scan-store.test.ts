import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { countActiveJobs, createJob, getJob, latestJobId, listLeads, migrateScan, reapStaleJobs } from '../lib/scan/store.ts'

const input = { business_name: 'Acme Pest', industry: 'pest control', location: 'Toronto' }

function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateScan(db)
  return db
}
function claim(db: Database.Database, id: string) {
  return db.prepare("UPDATE scan_jobs SET status='running', claimed_at=CAST(strftime('%s','now') AS INTEGER), attempts=attempts+1 WHERE id=? AND status='pending'").run(id).changes
}
function addLead(db: Database.Database, jobId: string, over: Record<string, unknown> = {}) {
  const l = { id: Math.random().toString(16).slice(2), name: 'Bob', company: 'Cafe X', contact: 'bob@x.com', signal: 'Failed inspection', source_url: 'https://example.com/r', score: 80, ...over }
  db.prepare('INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score) VALUES (@id,@scan_job_id,@name,@company,@contact,@signal,@source_url,@score)').run({ ...l, scan_job_id: jobId })
}

test('users cannot read each other\'s jobs or leads', () => {
  const db = setup()
  const a = createJob(db, 'user-a', input)
  const b = createJob(db, 'user-b', input)
  claim(db, a); claim(db, b)
  addLead(db, a, { company: 'A-only' }); addLead(db, b, { company: 'B-only' })
  assert.equal(getJob(db, 'user-b', a), undefined)
  assert.deepEqual(listLeads(db, 'user-b', a), [])
  assert.equal(listLeads(db, 'user-a', a).length, 1)
  assert.equal(listLeads(db, 'user-a', b).length, 0)
  assert.equal(latestJobId(db, 'user-a'), a)
  assert.equal(countActiveJobs(db, 'user-a'), 1)
})

test('claim is atomic: a job can be claimed once', () => {
  const db = setup()
  const id = createJob(db, 'u', input)
  assert.equal(claim(db, id), 1)
  assert.equal(claim(db, id), 0)
})

test('illegal status transitions are rejected by the database', () => {
  const db = setup()
  const id = createJob(db, 'u', input)
  assert.throws(() => db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(id), /illegal/)
  claim(db, id)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(id)
  assert.throws(() => db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id), /illegal/)
  assert.throws(() => db.prepare("UPDATE scan_jobs SET status='bogus' WHERE id=?").run(id))
})

test('leads need a running job, a signal and an http(s) source', () => {
  const db = setup()
  const id = createJob(db, 'u', input)
  assert.throws(() => addLead(db, id), /running/)
  claim(db, id)
  assert.throws(() => addLead(db, id, { signal: '' }))
  assert.throws(() => addLead(db, id, { source_url: 'javascript:alert(1)' }))
  assert.throws(() => addLead(db, id, { name: '', company: '' }))
  assert.throws(() => addLead(db, id, { score: 500 }))
  addLead(db, id)
  assert.equal(listLeads(db, 'u', id).length, 1)
})

test('stale running jobs are retried, then failed after max attempts', () => {
  const db = setup()
  const id = createJob(db, 'u', input)
  for (let i = 0; i < 3; i++) {
    claim(db, id)
    db.prepare("UPDATE scan_jobs SET claimed_at = CAST(strftime('%s','now') AS INTEGER) - 99999 WHERE id=?").run(id)
    reapStaleJobs(db)
    assert.equal(getJob(db, 'u', id)?.status, i < 2 ? 'pending' : 'failed')
  }
  assert.equal(getJob(db, 'u', id)?.error, 'timeout')
})

test('cross-scan dedupe: leads repeat-flagged by domain or normalized name, earliest job wins', async () => {
  const { markSeenBefore } = await import('../lib/scan/store.ts')
  const { companyKey } = await import('../lib/scan/evidence.ts')
  const db = setup()
  const j1 = createJob(db, 'user-a', input)
  claim(db, j1)
  addLead(db, j1, { company: 'Alpha Inc', company_domain: null })
  db.prepare("UPDATE leads SET company_domain = 'alpha.com' WHERE company = 'Alpha Inc'").run()
  addLead(db, j1, { company: 'Beta Co' })
  const j2 = createJob(db, 'user-b', input) // another tenant's history must not count
  claim(db, j2)
  addLead(db, j2, { company: 'Gamma' })
  db.prepare("UPDATE leads SET company_domain = 'gamma.com' WHERE company = 'Gamma'").run()
  const j3 = createJob(db, 'user-a', input)
  claim(db, j3)
  addLead(db, j3, { company: 'Alpha', })  // same company, looser name
  db.prepare("UPDATE leads SET company_domain = 'alpha.com' WHERE company = 'Alpha'").run()
  addLead(db, j3, { company: 'Beta Company' }) // normalized-name match
  addLead(db, j3, { company: 'Gamma' })        // only the OTHER tenant has it
  db.prepare("UPDATE leads SET company_domain = 'gamma.com' WHERE company = 'Gamma' AND scan_job_id = ?").run(j3)
  addLead(db, j3, { company: 'Fresh Newco' })
  assert.equal(markSeenBefore(db, 'user-a', j3, companyKey), 2)
  const flagged = (db.prepare('SELECT company FROM leads WHERE scan_job_id = ? AND seen_before = 1 ORDER BY company').all(j3) as { company: string }[]).map(r => r.company)
  assert.deepEqual(flagged, ['Alpha', 'Beta Company'])
  assert.equal(markSeenBefore(db, 'user-a', j1, companyKey), 0, 'the earliest job has nothing before it')
  assert.equal(markSeenBefore(db, 'user-a', 'no-such-job', companyKey), 0)
})
