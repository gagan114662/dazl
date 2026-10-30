import { test } from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateRunReport } from '../lib/scan/run-report.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { recentPlays } from '../lib/readiness.ts'

const NEUTRAL = 'Failed - the AI provider rejected the key this scan used'
const fail = (db: Database.Database, id: string, error: string) => {
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
  db.prepare("UPDATE scan_jobs SET status='failed', error=? WHERE id=?").run(error, id)
}
const snap = (db: Database.Database) => JSON.stringify(db.prepare('SELECT * FROM scan_jobs ORDER BY id').all())

// Instinct #274 re-review: a legacy key_rejected row gets funded_by 'user' from the real migration's column default.
test("a legacy rejected-key scan, migrated by the real migrateScan, is worded neutrally in history, campaign and Home", async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateRunReport(db)
  db.exec('ALTER TABLE scan_jobs DROP COLUMN funded_by') // the schema before the column existed
  const legacy = createJob(db, 'A', { business_name: 'x', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET query='Legacy search' WHERE id=?").run(legacy)
  fail(db, legacy, 'key_rejected')
  migrateScan(db) // re-adds funded_by with DEFAULT 'user'
  assert.equal((db.prepare('SELECT funded_by FROM scan_jobs WHERE id=?').get(legacy) as { funded_by: string }).funded_by, 'user', 'the migration really assigns the default')
  const trial = createJob(db, 'A', { business_name: 'x', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET query='Trial search', funded_by='trial' WHERE id=?").run(trial)
  fail(db, trial, 'key_rejected')
  const fresh = createJob(db, 'A', { business_name: 'x', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET query='New search' WHERE id=?").run(fresh)
  fail(db, fresh, 'key_rejected')
  const other = createJob(db, 'B', { business_name: 'x', industry: 'test', location: 'test' })
  fail(db, other, 'key_rejected')

  const before = snap(db)
  const jobs = await historyJobs(sqliteDb(db), 'A')
  assert.deepEqual(jobs.map(j => j.id).sort(), [legacy, trial, fresh].sort(), "own account only")
  const byId = (id: string) => jobs.find(j => j.id === id)!
  assert.deepEqual([byId(legacy).funded_by, byId(fresh).funded_by, byId(trial).funded_by], [null, null, 'trial'], "'user' is never synthesized")
  assert.deepEqual([scanOutcome(byId(legacy)).label, scanOutcome(byId(fresh)).label], [NEUTRAL, NEUTRAL])
  assert.equal(scanOutcome(byId(trial)).label, 'Failed - the free-search key had trouble (not your key)')
  const campaign = async (id: string) => { const d = (await campaignDetail(sqliteDb(db), 'A', id))!; return scanOutcome({ ...d.job, lead_count: d.leads.length }).label }
  assert.deepEqual([await campaign(legacy), await campaign(fresh), await campaign(trial)], [NEUTRAL, NEUTRAL, 'Failed - the free-search key had trouble (not your key)'])
  const plays = Object.fromEntries(recentPlays(jobs).map(p => [p.query, p.outcome]))
  assert.deepEqual(plays, { 'Legacy search': 'failed: AI key rejected', 'Trial search': 'failed: free-search key trouble', 'New search': 'failed: AI key rejected' })
  assert.equal(await campaignDetail(sqliteDb(db), 'A', other), null)
  assert.equal(snap(db), before, 'reading writes nothing')
})

// #254: the history read keeps the effective status - a finished scan still enriching is not reported as done.
test('history reports a scan still enriching as enriching, and a stale enrichment as done', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateRunReport(db)
  const now = Math.floor(Date.now() / 1000)
  const job = (started: number) => {
    const id = createJob(db, 'A', { business_name: 'x', industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
    db.prepare("UPDATE scan_jobs SET status='done', candidates=2, verified=1, needs_review=0, dropped=1, enrich_started_at=? WHERE id=?").run(started, id)
    return id
  }
  const live = job(now - 5), stale = job(now - 3600)
  const jobs = await historyJobs(sqliteDb(db), 'A')
  assert.equal(jobs.find(j => j.id === live)!.status, 'enriching')
  assert.equal(jobs.find(j => j.id === stale)!.status, 'done')
  assert.match(scanOutcome(jobs.find(j => j.id === stale)!).label, /contacts and fit checks did not finish$/)
})
