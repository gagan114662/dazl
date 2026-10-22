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

test('widenWhyCap: a database with the old 300-char why CHECK is rebuilt to 600, rows preserved, guards intact', () => {
  // Simulate a production database created before the cap widening: base schema, why capped at 300.
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 150),
      industry TEXT NOT NULL CHECK (length(industry) BETWEEN 1 AND 100),
      location TEXT NOT NULL CHECK (length(location) BETWEEN 1 AND 100),
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT CHECK (error IS NULL OR length(error) <= 200),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      claimed_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 150),
      company TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 150),
      contact TEXT CHECK (contact IS NULL OR length(contact) <= 254),
      signal TEXT NOT NULL CHECK (length(signal) BETWEEN 1 AND 500),
      source_url TEXT NOT NULL CHECK (length(source_url) <= 500 AND (source_url LIKE 'https://%' OR source_url LIKE 'http://%')),
      score INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      why TEXT CHECK (why IS NULL OR length(why) <= 300),
      CHECK (name <> '' OR company <> '')
    );
    CREATE TRIGGER leads_only_while_running BEFORE INSERT ON leads
    WHEN (SELECT status FROM scan_jobs WHERE id = NEW.scan_job_id) IS NOT 'running'
    BEGIN SELECT RAISE(ABORT, 'leads can only be added to a running job'); END;
  `)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'u', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, why) VALUES ('l1', 'j1', 'Pat', 'Acme', 'hiring', 'https://x.co/a', ?)").run('x'.repeat(290))
  assert.throws(() => db.prepare("UPDATE leads SET why = ? WHERE id = 'l1'").run('y'.repeat(400))) // old cap still on

  migrateScan(db) // widens

  assert.equal((db.prepare("SELECT length(why) AS n FROM leads WHERE id = 'l1'").get() as { n: number }).n, 290) // row preserved
  db.prepare("UPDATE leads SET why = ? WHERE id = 'l1'").run('y'.repeat(500)) // 500 now fits
  assert.throws(() => db.prepare("UPDATE leads SET why = ? WHERE id = 'l1'").run('z'.repeat(601))) // 601 still rejected
  // trigger restored: leads only into a running job
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j2', 'u', 'b', 'i', 'l', 'done')").run()
  assert.throws(() => db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('l2', 'j2', 'P', 'C', 'sig', 'https://x.co/b')").run())
  // dedup index restored
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'leads_dedup'").get()
  assert.ok(idx)
  migrateScan(db) // idempotent no-op
  assert.equal((db.prepare("SELECT count(*) AS n FROM leads").get() as { n: number }).n, 1)
})
