// Seeds a throwaway SQLite file for test/ui/research-email-1832.ui.mjs (#1832): a signed-in user whose one finished
// search holds three research-only leads - one under a hold that is not a searchable one (counterparty) with a
// restricted published inbox, one under a searchable hold with a restricted published inbox, and one with no address
// at all. Synthetic rows only; no scan, no provider call.
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const [dbPath, token] = process.argv.slice(2)
const db = new Database(dbPath)
migrateAllSqlite(db)
db.prepare("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES ('A', 'a@example.test', 'x', 'y', 1)").run()
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'A', Math.floor(Date.now() / 1000) + 3600)
const t = Math.floor(Date.now() / 1000) - 10_000
const JOB = 'e'.repeat(24)
// The icp carries the full shape every real job has (normalizeIcp always writes these arrays; the page's ICP summary reads them).
db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, verified, needs_review, dropped, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Synthetic research query', ?, 'running', 5, 0, 3, 2, ?)").run(JOB, JSON.stringify({ summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], window_days: 90 }), t)
const lead = (id: string, company: string, review: string, contact: string | null) =>
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, contact, review_reason, event_date) VALUES (?, ?, ?, 'a synthetic signal kept for research only', 'https://news.example/x', ?, ?, NULL)").run(id, JOB, company, contact, review)
lead('1'.repeat(24), 'Synthetic Counterparty Co', 'counterparty_signal', 'press@synthetic.example')
lead('2'.repeat(24), 'Synthetic Support Co', 'outside_window_undated', 'support@synthetic.example')
lead('3'.repeat(24), 'Synthetic No Email Co', 'outside_window_undated', null)
db.prepare('UPDATE scan_jobs SET status = ?, finished_at = ? WHERE id = ?').run('done', t, JOB)
db.close()
