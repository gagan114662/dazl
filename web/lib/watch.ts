// Watch scans: a saved query + ICP re-run weekly. Design approved by the repo owner on 2026-10-21:
// - every run counts against the monthly scan quota
// - never trial-funded: a watch with no user key pauses, it never touches the operator key
// - max 3 active watches per user
// - "new" = the lead's company domain (or normalized name) was not seen by this watch before
// - results surface in-app only
import { countActiveJobs } from './scan/store.ts'
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { createQueryJob } from './scan/store.ts'
import { hasKey } from './llm/key-store.ts'
import { scanQuota } from './plans.ts'

export const MAX_WATCHES = 3
const WEEK_S = 7 * 86400

export function migrateWatch(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS watches (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    query       TEXT NOT NULL,
    icp         TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    paused_reason TEXT,
    created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`)
  // Optional per-run budget (lib/scan/run-budget.ts), applied to EACH weekly run's job. It bounds one run, not the watch in total.
  if (!(db.prepare('PRAGMA table_info(watches)').all() as { name: string }[]).some(c => c.name === 'run_budget')) db.exec('ALTER TABLE watches ADD COLUMN run_budget TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS watches_due ON watches (active, next_run_at)')
  db.exec(`CREATE TABLE IF NOT EXISTS watch_seen (
    watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    seen_key   TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (watch_id, seen_key)
  )`)
}

export interface Watch { run_budget?: string | null; id: string; user_id: string; query: string; icp: string; active: number; next_run_at: number; last_run_at: number | null; paused_reason: string | null; created_at: number }

export function createWatch(db: Database.Database, userId: string, query: string, icp: string, runBudget: string | null = null): { watch?: Watch; error?: string } {
  const active = (db.prepare('SELECT count(*) AS n FROM watches WHERE user_id = ? AND active = 1').get(userId) as { n: number }).n
  if (active >= MAX_WATCHES) return { error: `You already have ${MAX_WATCHES} weekly watches. Pause or delete one first.` }
  const dupe = db.prepare('SELECT id FROM watches WHERE user_id = ? AND active = 1 AND query = ?').get(userId, query)
  if (dupe) return { error: 'You are already watching that search.' }
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO watches (id, user_id, query, icp, next_run_at, run_budget) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, query.slice(0, 600), icp, Math.floor(Date.now() / 1000) + WEEK_S, runBudget)
  return { watch: db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch }
}

export function listWatches(db: Database.Database, userId: string) {
  // created_at is whole seconds: id breaks ties so watches made in the same second always list in the same order
  const rows = db.prepare('SELECT * FROM watches WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId) as Watch[]
  return rows.map(w => {
    const last = db.prepare("SELECT id, status, finished_at FROM scan_jobs WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(w.id) as { id: string; status: string; finished_at: number | null } | undefined
    const newCount = last ? (db.prepare('SELECT count(*) AS n FROM leads WHERE scan_job_id = ? AND watch_new = 1').get(last.id) as { n: number }).n : 0
    return { id: w.id, query: w.query, icp: JSON.parse(w.icp) as unknown, active: w.active === 1, next_run_at: w.next_run_at, last_run_at: w.last_run_at, paused_reason: w.paused_reason, last_job_id: last?.id ?? null, last_status: last?.status ?? null, new_leads: newCount }
  })
}

export function watchAction(db: Database.Database, userId: string, id: string, action: 'pause' | 'resume' | 'delete'): boolean {
  if (action === 'delete') return db.prepare('DELETE FROM watches WHERE id = ? AND user_id = ?').run(id, userId).changes === 1
  if (action === 'pause') return db.prepare('UPDATE watches SET active = 0 WHERE id = ? AND user_id = ?').run(id, userId).changes === 1
  const ok = db.prepare('UPDATE watches SET active = 1, paused_reason = NULL, next_run_at = ? WHERE id = ? AND user_id = ?').run(Math.floor(Date.now() / 1000) + WEEK_S, id, userId).changes === 1
  return ok
}

// The domain (or normalized company name) is the identity a watch remembers.
export function seenKey(company: string, domain: string | null): string {
  if (domain) return domain.toLowerCase()
  return company.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// After a watch run finishes: flag leads this watch has never surfaced, and remember them.
export function markWatchLeads(db: Database.Database, watchId: string, jobId: string): number {
  const leads = db.prepare('SELECT id, company, company_domain FROM leads WHERE scan_job_id = ?').all(jobId) as { id: string; company: string; company_domain: string | null }[]
  const seen = new Set((db.prepare('SELECT seen_key FROM watch_seen WHERE watch_id = ?').all(watchId) as { seen_key: string }[]).map(r => r.seen_key))
  let fresh = 0
  const mark = db.prepare('UPDATE leads SET watch_new = 1 WHERE id = ?')
  const remember = db.prepare('INSERT OR IGNORE INTO watch_seen (watch_id, seen_key) VALUES (?, ?)')
  for (const l of leads) {
    const k = seenKey(l.company, l.company_domain)
    if (!seen.has(k) && k) { mark.run(l.id); fresh++ }
    remember.run(watchId, k)
  }
  return fresh
}

// Due watches -> one scan job each, funded by the user's own key only. Never trial-funded:
// no key or no quota pauses the watch with the reason, it does not fall back to the trial key.
export function runDueWatches(db: Database.Database, now = Math.floor(Date.now() / 1000)): { ran: number; paused: number } {
  const due = db.prepare('SELECT * FROM watches WHERE active = 1 AND next_run_at <= ?').all(now) as Watch[]
  let ran = 0, paused = 0
  for (const w of due) {
    const pause = (reason: string) => { db.prepare('UPDATE watches SET active = 0, paused_reason = ? WHERE id = ?').run(reason, w.id); paused++ }
    if (!hasKey(db, w.user_id)) { pause('no_api_key'); continue }
    if (!scanQuota(db, w.user_id).allowed) { pause('quota_exceeded'); continue }
    const activeJobs = countActiveJobs(db, w.user_id)
    if (activeJobs > 0) continue // a scan is already going; the next tick picks this watch up
    const jobId = createQueryJob(db, w.user_id, { query: w.query, icp: w.icp, watchId: w.id, runBudget: w.run_budget ?? null })
    db.prepare('UPDATE watches SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, now + WEEK_S, w.id)
    void jobId
    ran++
  }
  return { ran, paused }
}
