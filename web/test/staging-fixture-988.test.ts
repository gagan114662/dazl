// #988 staging fixture loader: dry-run default, exact tenant/environment guards, one transaction, idempotent, no collateral writes. In-memory SQLite, no network, no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { createQueryJob, finishJob, type LeadRow } from '../lib/scan/store-db.ts'
import { apply, plan, fixtureLeads, FixtureRefused, JOB_ID, QA_EMAIL, FIXTURE_TAG, type Env } from '../scripts/staging-fixture-988.mts'

const NOW = 1_800_000_000
const STAGING: Env = { DAZL_ENV: 'staging', DB_PATH: '/var/lib/dazl-staging/app.db' }
const user = (db: Database.Database, id: string, email: string) => db.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)').run(id, email, 'Owner', 'Biz', 'not-a-real-hash', 'salt')
async function world() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateAllSqlite(db)
  user(db, 'QA1', QA_EMAIL); user(db, 'OTHER', 'someone-else@example.test')
  // unrelated rows that must survive untouched: another tenant's finished run with a lead
  const sdb = sqliteDb(db)
  const job = await createQueryJob(sdb, 'OTHER', { query: 'unrelated real-shaped query' }, NOW - 5000)
  await sdb.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [NOW - 5000, job])
  const lead: LeadRow = { name: 'n', company: 'c', contact: null, signal: 's', source_url: 'https://c.example.test/', score: 50, evidence_excerpt: 'e', event_date: '2026-01-01', date_status: 'verified', retrieved_at: NOW - 6000, confidence: 70, dedup_key: 'unrelated:1' }
  await finishJob(sdb, { id: job, attempts: 1 }, { status: 'done', error: null, leads: [lead], candidates: 1, dropped: { off_profile: 0 }, now: NOW - 4000 })
  return db
}
const dump = (db: Database.Database) => {
  const out: Record<string, unknown[]> = {}
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) out[name] = db.prepare(`SELECT * FROM "${name}"`).all()
  return out
}
const count = (db: Database.Database, t: string, where = '1=1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get() as { n: number }).n
const refused = (fn: () => unknown, reason: string) => assert.throws(fn, (e: unknown) => e instanceof FixtureRefused && e.reason === reason, reason)

test('#988 fixture: dry-run (the default) writes nothing and names the exact expected changes', async () => {
  const db = await world(); const before = dump(db)
  const p = plan(db, STAGING, NOW)
  assert.deepEqual(dump(db), before, 'no row changed'); assert.equal(p.tenant, 'QA1'); assert.equal(p.mode, 'dry-run')
  assert.deepEqual(p.expected, { scan_jobs: 1, leads: 4 }); assert.deepEqual(p.leads.map(l => l.case), ['future', 'recent', 'old', 'missing'])
  db.close()
})
test('#988 fixture: apply adds exactly 1 saved run and 4 tagged leads to the QA tenant; every other row in every table is untouched', async () => {
  const db = await world(); const before = dump(db)
  const r = apply(db, STAGING, 'QA1', NOW)
  assert.deepEqual(r.applied, { scan_jobs: 1, leads: 4 })
  const after = dump(db)
  for (const t of Object.keys(before)) {
    if (t === 'scan_jobs' || t === 'leads') continue
    assert.deepEqual(after[t], before[t], `${t}: unchanged`)
  }
  assert.equal(after.scan_jobs.length, before.scan_jobs.length + 1); assert.equal(after.leads.length, before.leads.length + 4)
  for (const row of before.scan_jobs) assert.ok(after.scan_jobs.some(x => JSON.stringify(x) === JSON.stringify(row)), 'pre-existing job rows are byte-identical')
  for (const row of before.leads) assert.ok(after.leads.some(x => JSON.stringify(x) === JSON.stringify(row)), 'pre-existing lead rows are byte-identical')
  const job = db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(JOB_ID) as Record<string, unknown>
  assert.equal(job.user_id, 'QA1'); assert.equal(job.status, 'done', 'born done: no runner can claim it'); assert.equal(job.claimed_at, null); assert.ok(String(job.query).includes(FIXTURE_TAG))
  const leads = db.prepare('SELECT * FROM leads WHERE scan_job_id = ? ORDER BY id').all(JOB_ID) as Record<string, string | null>[]
  assert.equal(leads.length, 4)
  assert.deepEqual(leads.map(l => l.date_status).sort(), ['undated', 'unverified', 'verified', 'verified'])
  assert.equal(leads.filter(l => l.event_date === null).length, 1, 'one missing-date lead')
  const today = new Date(NOW * 1000).toISOString().slice(0, 10)
  assert.ok(leads.some(l => l.event_date! > today) && leads.some(l => l.event_date! < '2026-01-01'), 'a future and an old date are present')
  for (const l of leads) {
    assert.ok(String(l.name).includes(FIXTURE_TAG) && String(l.company).includes(FIXTURE_TAG) && String(l.evidence_excerpt).includes(FIXTURE_TAG), 'clearly tagged')
    assert.match(String(l.contact), /@[a-z0-9-]+\.example\.com$/); assert.match(String(l.source_url), /^https:\/\/[a-z0-9-]+\.example\.test\//)
  }
  assert.equal(count(db, 'scan_jobs', "status IN ('pending','running')"), 0, 'no pending/running job exists after apply')
  db.close()
})
test('#988 fixture: a repeat apply is a no-op (idempotent)', async () => {
  const db = await world(); apply(db, STAGING, 'QA1', NOW); const once = dump(db)
  const again = apply(db, STAGING, 'QA1', NOW + 999)
  assert.deepEqual(again.applied, { scan_jobs: 0, leads: 0 }); assert.deepEqual(again.expected, { scan_jobs: 0, leads: 0 }); assert.deepEqual(dump(db), once, 'byte-identical after the second run')
  db.close()
})
test('#988 fixture: refuses production / non-staging environments and a non-staging database path, writing nothing', async () => {
  const db = await world(); const before = dump(db)
  for (const env of [{ DB_PATH: STAGING.DB_PATH }, { ...STAGING, DAZL_ENV: 'production' }, { ...STAGING, DAZL_ENV: 'Staging' }, { ...STAGING, DAZL_ENV: '' }]) refused(() => apply(db, env, 'QA1', NOW), 'not_staging')
  refused(() => apply(db, { ...STAGING, DB_PATH: '/var/lib/dazl/app.db' }, 'QA1', NOW), 'not_a_staging_database')
  refused(() => apply(db, { ...STAGING, DB_PATH: undefined }, 'QA1', NOW), 'no_db_path')
  refused(() => apply(db, { ...STAGING, DAZL_STAGING_REAL_GMAIL: '1' }, 'QA1', NOW), 'real_gmail_on')
  refused(() => plan(db, { DAZL_ENV: 'production', DB_PATH: '/var/lib/dazl/app.db' }, NOW), 'not_staging')
  assert.deepEqual(dump(db), before); db.close()
})
test('#988 fixture: refuses any other tenant: wrong or missing --tenant-id, a missing or duplicate QA user; never creates a user', async () => {
  const db = await world(); const before = dump(db)
  refused(() => apply(db, STAGING, undefined, NOW), 'tenant_id_required'); refused(() => apply(db, STAGING, 'OTHER', NOW), 'tenant_id_mismatch'); refused(() => apply(db, STAGING, 'qa1', NOW), 'tenant_id_mismatch')
  assert.deepEqual(dump(db), before, 'nothing written on any refusal')
  const bare = new Database(':memory:'); migrateAllSqlite(bare); user(bare, 'OTHER', 'someone-else@example.test')
  refused(() => apply(bare, STAGING, 'OTHER', NOW), 'tenant_missing'); assert.equal(count(bare, 'users'), 1, 'no user was created'); assert.equal(count(bare, 'scan_jobs'), 0)
  user(bare, 'QA1', QA_EMAIL)
  let dup = true; try { user(bare, 'QA2', 'Instinct114114@Gmail.com') } catch { dup = false }   // the column may already forbid a case-variant duplicate
  if (dup) refused(() => apply(bare, STAGING, 'QA1', NOW), 'ambiguous_tenant')
  assert.equal(count(bare, 'scan_jobs'), 0, 'nothing written')
  bare.close(); db.close()
})
test('#988 fixture: the fixture job id already owned by another user, or a lead id used by another job, refuses', async () => {
  const db = await world()
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, 'OTHER', 'b', 'i', 'l', 'q', 'done', ?)").run(JOB_ID, NOW)
  const before = dump(db); refused(() => apply(db, STAGING, 'QA1', NOW), 'job_owned_by_other_tenant'); assert.deepEqual(dump(db), before)
  const db2 = await world(); const id = fixtureLeads(NOW)[2].id
  const other = 'abababababababababababab'
  db2.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, attempts, claimed_at, created_at) VALUES (?, 'OTHER', 'b', 'i', 'l', 'q', 'running', 1, ?, ?)").run(other, NOW, NOW)
  db2.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, dedup_key, created_at) VALUES (?, ?, 'n', 'c', 's', 'https://x.example.test/', 1, 'k', ?)").run(id, other, NOW)
  db2.prepare("UPDATE scan_jobs SET status = 'done', claimed_at = NULL WHERE id = ?").run(other)
  const b2 = dump(db2); refused(() => apply(db2, STAGING, 'QA1', NOW), 'lead_id_in_use'); assert.deepEqual(dump(db2), b2)
  db.close(); db2.close()
})
test('#988 fixture: transactional: a failure on the third lead rolls back the job and the earlier leads', async () => {
  const db = await world()
  // a trigger that fails the third fixture lead stands in for any mid-write failure (constraint, disk, crash)
  db.exec(`CREATE TRIGGER fail_third BEFORE INSERT ON leads WHEN NEW.dedup_key = 'fixture-988:old' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`)
  const before = dump(db)
  assert.throws(() => apply(db, STAGING, 'QA1', NOW), /simulated failure/)
  const after = dump(db); delete (after as Record<string, unknown>).sqlite_sequence
  assert.deepEqual(after.scan_jobs, before.scan_jobs, 'the job insert rolled back'); assert.deepEqual(after.leads, before.leads, 'earlier leads rolled back')
  db.exec('DROP TRIGGER fail_third'); assert.deepEqual(apply(db, STAGING, 'QA1', NOW).applied, { scan_jobs: 1, leads: 4 }, 'a clean retry then applies fully')
  db.close()
})
test('#988 fixture: the rows carry every column the production writer (finishJob) sets, so the pages read them like real runs', async () => {
  const db = await world(); apply(db, STAGING, 'QA1', NOW)
  const prod = db.prepare("SELECT * FROM leads WHERE dedup_key = 'unrelated:1'").get() as Record<string, unknown>
  const fx = db.prepare("SELECT * FROM leads WHERE id = ?").get(fixtureLeads(NOW)[1].id) as Record<string, unknown>
  for (const [k, v] of Object.entries(prod)) if (v !== null) assert.ok(fx[k] !== null && fx[k] !== undefined, `lead column ${k} (set by finishJob) is set by the fixture`)
  const pj = db.prepare("SELECT * FROM scan_jobs WHERE user_id = 'OTHER'").get() as Record<string, unknown>, fj = db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(JOB_ID) as Record<string, unknown>
  for (const k of ['status', 'finished_at', 'candidates', 'verified', 'needs_review', 'dropped', 'created_at', 'business_name', 'query']) assert.ok(pj[k] !== null && fj[k] !== null, `scan_jobs.${k}`)
  db.close()
})

test('#988 fixture: a partially present fixture (job without all its leads) is refused, never reopened', async () => {
  const db = await world(); apply(db, STAGING, 'QA1', NOW)
  db.prepare('DELETE FROM leads WHERE id = ?').run(fixtureLeads(NOW)[3].id)
  const before = dump(db); refused(() => apply(db, STAGING, 'QA1', NOW), 'partial_fixture'); assert.deepEqual(dump(db), before); db.close()
})
