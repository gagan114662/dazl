// #988 staging fixture loader: dry-run default, exact tenant/environment guards, one transaction, idempotent, no collateral writes. In-memory SQLite, no network, no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { createQueryJob, finishJob, type LeadRow } from '../lib/scan/store-db.ts'
import { apply, checkDbFile, plan, fixtureLeads, FixtureRefused, JOB_ID, QA_EMAIL, FIXTURE_TAG, STAGING_DB_PATH, type Env } from '../scripts/staging-fixture-988.mts'
import { backupTo, compareAfter, restoreCheck, takeSnapshot } from '../scripts/staging-fixture-988-checks.mts'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  for (const bad of ['/var/lib/dazl/app.db', '/tmp/staging/app.db', '/home/x/dazl-staging/app.db', '/var/lib/dazl-staging/app.db.bak', '/var/lib/dazl-staging/../dazl/app.db', '/var/lib/dazl-staging//app.db', 'var/lib/dazl-staging/app.db', '/var/lib/dazl-staging/app.db ', '/var/lib/dazl-staging/APP.db', '/var/lib/dazl-staging'])
    refused(() => apply(db, { ...STAGING, DB_PATH: bad }, 'QA1', NOW), 'not_the_staging_database')
  assert.equal(STAGING_DB_PATH, '/var/lib/dazl-staging/app.db')
  assert.throws(() => checkDbFile(STAGING_DB_PATH, () => '/var/lib/dazl/app.db'), (e: unknown) => e instanceof FixtureRefused && e.reason === 'db_path_resolves_elsewhere', 'a symlink/bind resolving elsewhere refuses')
  assert.throws(() => checkDbFile(STAGING_DB_PATH, () => { throw new Error('ENOENT') }), (e: unknown) => e instanceof FixtureRefused && e.reason === 'db_missing')
  assert.doesNotThrow(() => checkDbFile(STAGING_DB_PATH, () => STAGING_DB_PATH))
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

// ---- existing fixture rows: contents and ownership are verified, matching ids alone are not trusted ----
const LEAD = (n: number) => fixtureLeads(NOW)[n].id
const conflict = async (mutate: (db: Database.Database) => void, reason = 'existing_fixture_conflict', label = '') => {
  const db = await world(); apply(db, STAGING, 'QA1', NOW)
  // someone editing around the database's own guards (status-transition and lead triggers): the tool must not trust that the guards held
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) db.exec(`DROP TRIGGER "${name}"`)
  mutate(db)
  const before = dump(db)
  refused(() => apply(db, STAGING, 'QA1', NOW + 5), reason); refused(() => plan(db, STAGING, NOW + 5), reason)
  assert.deepEqual(dump(db), before, `${label || reason}: the whole change was refused, nothing written`); db.close()
}
test('#988 fixture: an existing fixture is accepted only if every field matches; any edited job field refuses the whole change', async () => {
  for (const [col, val] of [['query', 'something else'], ['status', 'failed'], ['candidates', 99], ['icp', '{"summary":"changed"}'], ['business_name', 'Real Co'], ['error', 'boom'], ['dropped', 3]] as const)
    await conflict(db => db.prepare(`UPDATE scan_jobs SET ${col} = ? WHERE id = ?`).run(val, JOB_ID), 'existing_fixture_conflict', `scan_jobs.${col}`)
})
test('#988 fixture: an existing fixture lead with changed content (contact, evidence, source, tag, dedup key, date class) refuses the whole change', async () => {
  const set = (col: string, val: unknown) => (db: Database.Database) => { db.prepare(`UPDATE leads SET ${col} = ? WHERE id = ?`).run(val, LEAD(1)) }
  await conflict(set('contact', 'real.person@gmail.com'), undefined, 'contact'); await conflict(set('source_url', 'https://real-company.com/x'), undefined, 'source_url')
  await conflict(set('evidence_excerpt', 'copied from a real page'), undefined, 'evidence'); await conflict(set('name', 'A Real Person'), undefined, 'name'); await conflict(set('dedup_key', 'other'), undefined, 'dedup_key')
  await conflict(set('score', 99), undefined, 'score'); await conflict(set('date_status', 'unverified'), undefined, 'date_status')   // lead 1 is the recent/verified case
  await conflict(db => { db.prepare("UPDATE leads SET event_date = '2001-01-01' WHERE id = ?").run(LEAD(0)) }, undefined, 'future lead with an old date')
  await conflict(db => { db.prepare("UPDATE leads SET event_date = '2030-01-01', date_status = 'verified' WHERE id = ?").run(LEAD(3)) }, undefined, 'missing-date lead given a date')
})
test('#988 fixture: columns the tool never sets must still be at their defaults (an enriched or reviewed row is not ours)', async () => {
  await conflict(db => { db.prepare("UPDATE leads SET review_reason = 'edited by hand' WHERE id = ?").run(LEAD(2)) }, undefined, 'lead review_reason')
  await conflict(db => { db.prepare("UPDATE leads SET evidence_copy_id = 'abc' WHERE id = ?").run(LEAD(0)) }, undefined, 'lead evidence_copy_id')
})
test('#988 fixture: ownership: an extra lead on the fixture job, a row in another table referencing it, a stray fixture lead without the job, or another tenant\'s job all refuse the whole change', async () => {
  await conflict(db => { db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, dedup_key, created_at) VALUES ('f988f988f988f988f988f9ff', ?, 'n', 'c', 's', 'https://x.example.test/', 1, 'k', 1)").run(JOB_ID) }, undefined, 'extra lead')
  await conflict(db => { db.prepare("UPDATE scan_jobs SET user_id = 'OTHER' WHERE id = ?").run(JOB_ID) }, 'job_owned_by_other_tenant', 'other tenant')
  const db = await world(); const fk = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('scan_jobs','leads') AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).find(t => (db.prepare(`PRAGMA foreign_key_list(${t.name})`).all() as { table: string }[]).some(f => f.table === 'scan_jobs'))
  assert.ok(fk, 'fixture: the schema has a table that references scan_jobs'); db.close()
  // a real dependent row in that table (every NOT NULL column without a default filled generically), pointing at the fixture job
  await conflict(d => {
    const ref = (d.prepare(`PRAGMA foreign_key_list(${fk!.name})`).all() as { table: string; from: string }[]).find(f => f.table === 'scan_jobs')!
    const cols = (d.prepare(`PRAGMA table_info(${fk!.name})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]).filter(c => c.name === ref.from || (c.notnull && c.dflt_value === null))
    const val = (c: { name: string; type: string }) => c.name === ref.from ? JOB_ID : /INT|REAL|NUM/i.test(c.type) ? 1 : 'x'
    d.prepare(`INSERT INTO ${fk!.name} (${cols.map(c => `"${c.name}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(val))
  }, undefined, `dependent row in ${fk!.name}`)
  // the stray lead: job absent but a fixture lead id present
  const d2 = await world(); const oj = 'cdcdcdcdcdcdcdcdcdcdcdcd'
  d2.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, attempts, claimed_at, created_at) VALUES (?, 'OTHER', 'b', 'i', 'l', 'q', 'running', 1, 1, 1)").run(oj)
  d2.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, dedup_key, created_at) VALUES (?, ?, 'n', 'c', 's', 'https://x.example.test/', 1, 'k', 1)").run(LEAD(3), oj)
  d2.prepare("UPDATE scan_jobs SET status = 'done', claimed_at = NULL WHERE id = ?").run(oj)
  const b2 = dump(d2); refused(() => apply(d2, STAGING, 'QA1', NOW), 'lead_id_in_use'); assert.deepEqual(dump(d2), b2); d2.close()
})
test('#988 fixture: a valid existing fixture checked on a LATER day is still accepted and still a no-op (dates are checked by class)', async () => {
  const db = await world(); apply(db, STAGING, 'QA1', NOW); const once = dump(db)
  const later = apply(db, STAGING, 'QA1', NOW + 20 * 86_400); assert.deepEqual(later.applied, { scan_jobs: 0, leads: 0 }); assert.deepEqual(dump(db), once); db.close()
})

// ---- backup / restore / unrelated-data checks ----
const tmpDb = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx988-t-')), file = join(dir, 'live.db'), db = await world()
  await db.backup(file); db.close(); return { dir, file }
}
test('#988 checks: snapshot -> backup -> apply -> unrelated-data check passes, and the backup restores to exactly the pre-change snapshot', async () => {
  const { dir, file } = await tmpDb()
  try {
    const live = new Database(file); live.pragma('foreign_keys = ON')
    const before = takeSnapshot(live); const bak = join(dir, 'backup.db')
    await backupTo(live, bak)
    assert.deepEqual(restoreCheck(bak, before), [], 'the backup reproduces the snapshot exactly')
    apply(live, STAGING, 'QA1', NOW)
    assert.deepEqual(compareAfter(before, takeSnapshot(live)), [], 'only scan_jobs +1 and leads +4; schema and every unrelated row identical')
    assert.deepEqual(restoreCheck(bak, before), [], 'the backup is unaffected by the apply')
    live.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('#988 checks: the unrelated-data check catches an unrelated change, an extra row, a schema change, a lost user, and a backup that differs; a backup never overwrites', async () => {
  const { dir, file } = await tmpDb()
  try {
    const live = new Database(file); const before = takeSnapshot(live); const bak = join(dir, 'b.db'); await backupTo(live, bak)
    apply(live, STAGING, 'QA1', NOW)
    live.prepare("UPDATE users SET business_name = 'tampered' WHERE id = 'OTHER'").run()
    assert.ok(compareAfter(before, takeSnapshot(live)).some(p => /users: unrelated rows changed/.test(p)))
    live.prepare("UPDATE users SET business_name = 'Biz' WHERE id = 'OTHER'").run()
    assert.deepEqual(compareAfter(before, takeSnapshot(live)), [], 'restored by hand: clean again')
    live.prepare("UPDATE leads SET score = 1 WHERE dedup_key = 'unrelated:1'").run(); assert.ok(compareAfter(before, takeSnapshot(live)).some(p => /leads: unrelated rows changed/.test(p)))
    live.exec('CREATE TABLE sneaky (x)'); assert.ok(compareAfter(before, takeSnapshot(live)).some(p => /schema changed|sneaky/.test(p)))
    const extra = new Database(join(dir, 'x.db')); extra.exec('CREATE TABLE t (a)'); extra.close()
    assert.ok(restoreCheck(join(dir, 'x.db'), before).length > 0, 'a backup that does not match the snapshot fails the restore check')
    assert.ok(compareAfter(before, takeSnapshot(live), { scan_jobs: 1, leads: 3 }).some(p => /leads: 4 row\(s\) added, expected 3/.test(p)), 'an unexpected number of added rows is reported')
    await assert.rejects(() => backupTo(live, bak), (e: unknown) => e instanceof FixtureRefused && e.reason === 'backup_exists')
    writeFileSync(join(dir, 'garbage.db'), 'not a database'); assert.throws(() => restoreCheck(join(dir, 'garbage.db'), before))
    live.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('#988 checks: a snapshot ignores the fixture rows themselves, so before-apply and after-apply compare on unrelated data only', async () => {
  const db = await world(); const a = takeSnapshot(db); apply(db, STAGING, 'QA1', NOW); const b = takeSnapshot(db)
  assert.equal(a.tables.scan_jobs.hash, b.tables.scan_jobs.hash); assert.equal(a.tables.leads.hash, b.tables.leads.hash); assert.equal(b.tables.leads.fixtureRows, 4); assert.equal(b.tables.scan_jobs.fixtureRows, 1); db.close()
})
