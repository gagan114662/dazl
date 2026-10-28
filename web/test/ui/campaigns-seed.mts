// Seeds a throwaway SQLite file for test/ui/campaigns.ui.mjs: every app migration, a signed-in user A with three
// searches at different stages, and a user B whose data must never show. Synthetic rows only.
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const [dbPath, token] = process.argv.slice(2)
const db = new Database(dbPath)
migrateAllSqlite(db)
for (const u of ['A', 'B']) db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')").run(u, `${u}@example.test`)
db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'A', Math.floor(Date.now() / 1000) + 3600)
let t = Math.floor(Date.now() / 1000) - 10_000
// Jobs start running (the schema only accepts leads then), then finish.
const job = (user: string, id: string, query: string, candidates: number | null) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, ?, 'x', '(from request)', '-', ?, 'running', ?, ?)").run(id, user, query, candidates, t += 100)
const lead = (jobId: string, id: string, o: { confidence?: number | null; excerpt?: string | null; review?: string | null; confirmed?: number | null; contact?: string | null; quarantined?: number | null } = {}) =>
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, human_confirmed_at, contact, quarantined_at) VALUES (?, ?, 'Co', 'opened an office', 'https://news.example/x', ?, ?, ?, ?, ?, ?)")
    .run(id, jobId, o.confidence === undefined ? 80 : o.confidence, o.excerpt === undefined ? 'Co opened an office' : o.excerpt, o.review ?? null, o.confirmed ?? null, o.contact ?? null, o.quarantined ?? null)
const msg = (tenant: string, leadId: string, status: string) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, 'a@b.example', 'Hello', 'A body that is long enough to pass the check.', ?)").run(`m-${leadId}`, tenant, leadId, status)
const end = (id: string, status = 'done', error: string | null = null) => db.prepare('UPDATE scan_jobs SET status = ?, error = ? WHERE id = ?').run(status, error, id)

// 1. Ohio: needs review first, though it also has a draft and a sent email with an interested reply.
job('A', 'a'.repeat(24), 'Dental owners in Ohio - opened a new location', 9)
lead('a'.repeat(24), 'l1', { contact: 'hello@one.example' }); lead('a'.repeat(24), 'l2', { contact: 'hi@two.example' })
lead('a'.repeat(24), 'l3', { confidence: null, excerpt: null, review: 'quote_unconfirmed' }); lead('a'.repeat(24), 'l4', { quarantined: 1, contact: 'q@x.example' })
end('a'.repeat(24))
msg('A', 'l1', 'draft'); msg('A', 'l2', 'sent')
db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('g1','A','t1','l2','a@b.example','yes please','positive',1)").run()
// 2. NYC: two drafts waiting for approval.
job('A', 'b'.repeat(24), 'Clinic administrators in NYC - hiring front-desk staff', 4)
lead('b'.repeat(24), 'm1', { contact: 'a@c.example' }); lead('b'.repeat(24), 'm2', { contact: 'b@c.example' }); end('b'.repeat(24))
msg('A', 'm1', 'draft'); msg('A', 'm2', 'draft')
// 3. A failed search.
job('A', 'c'.repeat(24), 'Orthodontists in Austin', null); end('c'.repeat(24), 'failed', 'no_candidates')
// 4. Instinct's legacy row: confidence 90 and a contact but no stored excerpt -> unverified, never "ready to draft".
job('A', 'e'.repeat(24), 'Legacy search', 1); lead('e'.repeat(24), 'g1', { confidence: 90, excerpt: null, contact: 'hello@legacy.example' }); end('e'.repeat(24))
// B's search must never appear for A.
job('B', 'd'.repeat(24), 'B-ONLY SEARCH', 3); lead('d'.repeat(24), 'b1', { contact: 'x@b.example' }); end('d'.repeat(24)); msg('B', 'b1', 'draft')
db.close()
