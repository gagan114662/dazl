// #448 (from the adversarial probe): the REAL tick route (app/api/internal/tick/route.ts) draining autopilot first touches
// through the lease-fenced SQLite view, in staging mode (Gmail stubbed, nothing leaves). Run by test/autopilot-tick.test.ts
// through the tenant-route loader. Then: a drain that throws, and one that stops, as the scheduler run records them
// (kind 'autopilot' in scheduler_progress, like the other kinds of work).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { seedOffers } from './seed-offer.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { CONSENT_VERSION } from '../../lib/outreach/autopilot.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { createJob } from '../../lib/scan/store.ts'
import { BLOCKED_AFTER_FAILURES, schedulerHealth, tenantFreshness } from '../../lib/ops/scheduler-runs.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_ENABLED = '1'
process.env.AUTOPILOT_WARMUP = '2'
process.env.AUTOPILOT_TICK_SECRET = 'autopilot-tick-secret'
const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const T = 'tenant-autopilot-448'
db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(T, `${T}@example.test`, 'Probe Co')
saveSettings(db, T, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
seedOffers(db, [T])
startOAuth(db, T, { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never })
// autopilot on, consent current, cap 1, follow-ups off (first touches do not need them)
db.prepare('INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, consent_at, daily_cap, followups_enabled) VALUES (?, 1, 0, ?, ?, 1, 0)').run(T, CONSENT_VERSION, Math.floor(Date.now() / 1000))
// past warm-up: two sends the user approved long ago
const NOW = Math.floor(Date.now() / 1000)
db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2',?,'x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2',?,'x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(T, NOW - 30 * 86400, NOW - 30 * 86400, T, NOW - 30 * 86400, NOW - 30 * 86400)
function lead(contact: string) {
  const job = createJob(db, T, { business_name: 'Probe Co', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Co ' + id.slice(0, 4), contact, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at=?, human_confirmed_from='test_review' WHERE id = ?").run(NOW, id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job) // finished: its gates have run; only leads of a done scan are autopilot's candidates
  return id
}
lead('a@one.example'); lead('b@two.example')
const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer autopilot-tick-secret' } }))).json()
const runs = () => db.prepare('SELECT status, tenants_attempted, tenants_failed, error FROM scheduler_runs ORDER BY started_at, rowid').all() as { status: string; tenants_attempted: number; tenants_failed: number; error: string | null }[]
const work = () => db.prepare('SELECT reason, next_at, claimed_at FROM autopilot_work ORDER BY created_at').all() as { reason: string; next_at: number | null; claimed_at: number | null }[]
const msgs = () => db.prepare("SELECT to_email, status FROM outreach_messages WHERE tenant_id = ? AND id NOT LIKE 's%a2b3c4%' ORDER BY to_email").all(T) as { to_email: string; status: string }[]
const audit = () => (db.prepare("SELECT action, detail FROM autopilot_audit WHERE tenant_id = ? ORDER BY created_at, rowid").all(T) as { action: string; detail: string | null }[]).map(a => a.detail ? `${a.action}:${a.detail}` : a.action)

const progress = () => db.prepare('SELECT kind, last_outcome, last_hold, last_error, consecutive_failures FROM scheduler_progress WHERE tenant_id = ?').all(T) as { kind: string; last_outcome: string; last_hold: string | null; last_error: string | null; consecutive_failures: number }[]

test('tick 1: the real route drains a first touch through the fenced view (cap 1): one stub send, one held; the drain recorded as this tenant\'s autopilot progress', async () => {
  const r = await call()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual([r.first_touches, r.tenant_failures, r.tenant_holds], [1, 0, 0], JSON.stringify(r))
  assert.deepEqual(msgs().map(m => m.status), ['sent', 'draft'])
  assert.deepEqual(work().map(w => w.reason), ['daily_cap'])
  assert.deepEqual(runs().map(x => x.status), ['ok'])
  assert.deepEqual(audit().filter(a => a.startsWith('sent') || a.startsWith('send_')).map(a => a.split(':')[0]), ['sent'], audit().join(','))
  // one send went, then the cap: work was done, so the tick is a success for this tenant
  assert.deepEqual(progress().map(p => [p.kind, p.last_outcome]), [['autopilot', 'success']])
})

test('tick 2: the window moved on (audit backdated), the held draft is due: the next tick sends it once; a tick with nothing to do is a success', async () => {
  db.prepare('UPDATE autopilot_audit SET created_at = created_at - 90000').run()
  db.prepare('UPDATE autopilot_work SET next_at = ?').run(NOW - 1)
  const r = await call()
  assert.deepEqual([r.ok, r.first_touches, r.tenant_failures], [true, 1, 0], JSON.stringify(r))
  assert.deepEqual(msgs().map(m => m.status), ['sent', 'sent'])
  assert.equal(work().length, 0)
  const again = await call()
  assert.deepEqual([again.first_touches, msgs().length, progress()[0].last_outcome], [0, 2, 'success'], 'nothing more to send, no new draft')
})

test('tick 3: the drain throws for the tenant (queue table unreadable): a tenant failure the run and its progress row both carry', async () => {
  lead('c@three.example')
  db.exec('ALTER TABLE autopilot_work RENAME TO autopilot_work_gone')
  const r = await call()
  db.exec('ALTER TABLE autopilot_work_gone RENAME TO autopilot_work')
  assert.equal(r.ok, true)
  assert.equal(r.tenant_failures, 1, JSON.stringify(r))
  const last = runs().at(-1)!
  assert.deepEqual([last.status, last.tenants_failed], ['partial', 1], JSON.stringify(last))
  const [p] = progress()
  assert.deepEqual([p.kind, p.last_outcome, p.consecutive_failures], ['autopilot', 'failure', 1]); assert.match(p.last_error ?? '', /^SqliteError: no such table/)
  const fresh = await tenantFreshness(db, T)
  assert.equal(fresh.state, 'healthy', 'one failure is not yet a block'); assert.equal(fresh.work[0].consecutive_failures, 1)
})

test('tick 4: the drain fails the same way three more ticks running: the tenant is blocked and the operator told', async () => {
  db.exec('ALTER TABLE autopilot_work RENAME TO autopilot_work_gone')
  for (let i = 0; i < 3; i++) await call()
  db.exec('ALTER TABLE autopilot_work_gone RENAME TO autopilot_work')
  const fresh = await tenantFreshness(db, T)
  const health = await schedulerHealth(db)
  assert.deepEqual([fresh.state, fresh.reasons, progress()[0].consecutive_failures >= BLOCKED_AFTER_FAILURES], ['blocked', ['autopilot_failing'], true], JSON.stringify({ fresh, runs: runs().map(x => [x.status, x.tenants_failed]) }))
  assert.equal(health.tenants.blocked, 1); assert.ok(health.problems.length > 0, JSON.stringify(health))
})

test('tick 5: a drain that stops because Gmail needs a reconnect (a refusal, not a throw): recorded as this tenant\'s hold with the stop code; nothing sent', async () => {
  db.prepare('UPDATE autopilot_audit SET created_at = created_at - 90000').run(); db.prepare('UPDATE autopilot_work SET next_at = ?').run(NOW - 1)
  db.prepare("UPDATE gmail_accounts SET status = 'needs_reconnect' WHERE tenant_id = ?").run(T)
  const r = await call()
  assert.equal(msgs().filter(m => m.status === 'sent').length, 2, 'nothing sent with Gmail needing a reconnect')
  const [p] = progress()
  assert.deepEqual([r.tenant_holds, r.tenant_failures, p.last_outcome, p.last_hold], [1, 0, 'hold', 'gmail_not_connected'], JSON.stringify({ r, p }))
  assert.deepEqual(db.prepare('SELECT paused, pause_reason FROM autopilot_settings WHERE tenant_id = ?').get(T), { paused: 1, pause_reason: 'gmail_not_connected' })
  assert.deepEqual(work().map(w => w.reason), ['gmail_not_connected'])
})
