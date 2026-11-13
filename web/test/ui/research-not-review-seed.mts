// Seeds a throwaway SQLite file for test/ui/research-not-review.ui.mjs (#683, part of #352): every app migration, a signed-in
// user A whose only search is the live audit's NYC dental zero-ready run - two leads no check can make ready (no usable date
// under a 90-day window; someone else's customer) - and a user B whose research row must never show. Synthetic rows only.
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const [dbPath, token] = process.argv.slice(2)
const db = new Database(dbPath)
migrateAllSqlite(db)
for (const u of ['A', 'B']) db.prepare("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES (?, ?, 'x', 'y', 1)").run(u, `${u}@example.test`)
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'A', Math.floor(Date.now() / 1000) + 3600)
const recent = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
let t = Math.floor(Date.now() / 1000) - 10_000
const job = (user: string, id: string, query: string) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, verified, needs_review, dropped, created_at) VALUES (?, ?, 'x', '(from request)', '-', ?, ?, 'running', 5, 0, 2, 3, ?)")
  .run(id, user, query, JSON.stringify({ window_days: 90 }), t += 100)
const lead = (jobId: string, id: string, company: string, review: string, date: string | null, signal: string) =>
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date) VALUES (?, ?, ?, ?, 'https://news.example/x', NULL, NULL, ?, ?)")
    .run(id, jobId, company, signal, review, date)
const end = (id: string) => db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(t, id)

const NYC = 'a'.repeat(24)
job('A', NYC, 'Dental practices in New York hiring front desk staff')
lead(NYC, '1'.repeat(24), 'Synthetic Smiles NYC', 'outside_window_undated', null, 'hiring a receptionist')
lead(NYC, '2'.repeat(24), 'Example Dental Group', 'counterparty_signal', recent, 'named as a customer of a booking vendor')
end(NYC)
job('B', 'b'.repeat(24), 'B-ONLY SEARCH'); lead('b'.repeat(24), '3'.repeat(24), 'B Co', 'outside_window_undated', null, 'x'); end('b'.repeat(24))
db.close()
