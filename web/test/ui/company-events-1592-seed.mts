// Seeds a throwaway SQLite file for test/ui/company-events-1592.ui.mjs (#1592): a signed-in user whose one finished
// search holds two discovery-lane leads - a funding event with its printed amount and a verified event date, and a
// non-event lead as the control. Synthetic rows only; no scan, no provider call.
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const [dbPath, token] = process.argv.slice(2)
const db = new Database(dbPath)
migrateAllSqlite(db)
db.prepare("INSERT INTO users (id, email, password_hash, salt, email_verified_at) VALUES ('A', 'a@example.test', 'x', 'y', 1)").run()
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'A', Math.floor(Date.now() / 1000) + 3600)
const t = Math.floor(Date.now() / 1000) - 10_000
const JOB = 'f'.repeat(24)
// The icp carries the full shape every real job has (normalizeIcp always writes these arrays; the page's ICP summary reads them).
db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, verified, dropped, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Synthetic company-events query', ?, 'running', 2, 2, 0, ?)").run(JOB, JSON.stringify({ summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], window_days: 90 }), t)
const day = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const lead = (id: string, company: string, signal: string, why: string, kind: string | null, amount: string | null) =>
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, evidence_excerpt, event_date, date_status, retrieved_at, confidence, fit, intent, why, source_kind, company_domain, event_kind, event_amount, event_date_proof) VALUES (?, ?, 'Dana Ruiz', ?, ?, 'https://news.example/x', ?, ?, 'verified', ?, 85, 4, 4, ?, 'discover', 'synthetic-funding.example', ?, ?, 'page_bound')").run(id, JOB, company, signal, `${company} ${signal}`, day, t, why, kind, amount)
lead('1'.repeat(24), 'Synthetic Funding Co', 'Raised a seed round of US$4.2 million', 'a first round pays for the fit-out the seller quotes', 'funding', 'US$4.2 million')
lead('2'.repeat(24), 'Synthetic Quiet Co', 'Posted a guide to clinic operations', 'fits the seller\'s usual buyers', null, null)
// The buyer the run found, as the lane records it (lib/scan/runner.ts writes this row for a named person).
db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('p1', '1', 'A', 'discover', 'person', 'Dana Ruiz, Founder', 'named on a public page', NULL, 'https://news.example/x', ?, ?)").run(day, t)
db.prepare('UPDATE scan_jobs SET status = ?, finished_at = ? WHERE id = ?').run('done', t, JOB)
db.close()
