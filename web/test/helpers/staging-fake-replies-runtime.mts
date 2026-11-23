// #413 staging live-check path, through the REAL tick route on a synthetic store, run by test/staging-fake-replies-413.test.ts
// through the tenant-route loader. Staging mode with the stub Gmail and DAZL_STAGING_FAKE_REPLIES=1: the real reply sync reads
// the test-only fake threads (lib/outreach/staging-fake-replies.ts). No fetch is replaced: the net fence stays in front, so any
// real provider call would throw. Synthetic tenants and recipients only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { createJob } from '../../lib/scan/store.ts'
import { replySafetyStale } from '../../lib/outreach/store.ts'
import { isSuppressed, saveSettings, sendBlockReason, sendMessage } from '../../lib/outreach/service.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_STAGING_FAKE_REPLIES = '1'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_AVAILABLE = '1'; process.env.AUTOPILOT_ENABLED = '1'
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const now = () => Math.floor(Date.now() / 1000)
// S: a clean sync (opt-out + quiet thread). Q: one thread errors (partial sync). Both first-touch-only: no autopilot row, no sequence.
const S = 'tenant-s-staging-first-touch', Q = 'tenant-q-staging-partial'
for (const t of [S, Q]) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(t, `${t}@example.test`, `${t} business`)
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  startOAuth(db, t, { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never })
  acceptReadConsent(db, t)
}

function newLead(to: string, t = S) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, ?, 'Northside', ?, 'Hiring', 'https://n.example/a', 'Northside is hiring', 90, ?, 'test_review')").run(lead, job, to, now() - 5 * 86400)
  return lead
}
function firstTouch(to: string, t = S) {
  const lead = newLead(to, t), mid = randomBytes(12).toString('hex'), g = `stub${randomBytes(8).toString('hex')}`
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, t, lead, to, now() - 3 * 86400, now() - 3 * 86400, g, g)
  return { mid, thread: g }
}
function approvedTo(to: string, t = S) {
  const lead = newLead(to, t), id = randomBytes(12).toString('hex'), subject = 'Following up', body = 'bodybodybodybodybodybody two'
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, approved_hash) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)").run(id, t, lead, to, subject, body, createHash('sha256').update(JSON.stringify([to, subject, body])).digest('hex'))
  return id
}
const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))).json()
const progress = (t = S) => db.prepare("SELECT last_success_at, last_outcome FROM scheduler_progress WHERE tenant_id = ? AND kind = 'reply_sync'").get(t) as { last_success_at: number | null; last_outcome: string } | undefined
const inbound = () => db.prepare('SELECT from_email, classification FROM inbound_messages WHERE tenant_id = ?').all(S) as { from_email: string; classification: string }[]

const optout = 'staging+fake-optout@buyer.example', quiet = 'staging+quiet@third.example', broken = 'staging+fake-syncerror@other.example'
firstTouch(optout); firstTouch(quiet)
firstTouch('staging+quiet@q.example', Q)
firstTouch(broken, Q)

test('#413 staging fake replies: the real tick ingests an opt-out, suppresses, refuses the next send, and a partial sync holds as stale', async () => {
  assert.equal((await call()).ok, true)
  assert.deepEqual(inbound(), [{ from_email: optout, classification: 'opt_out' }], 'only the fake-optout thread has a reply')
  assert.equal(isSuppressed(db, S, optout), true)
  assert.equal(isSuppressed(db, S, quiet), false)
  const again = approvedTo(optout)
  assert.equal(sendBlockReason(db, S, again, { skipAccount: true }), 'suppressed')
  await assert.rejects(sendMessage(db, S, again), (e: Error & { code?: string }) => e.code === 'suppressed')
  assert.deepEqual(db.prepare('SELECT status, gmail_id, sent_at FROM outreach_messages WHERE id = ?').get(again), { status: 'skipped', gmail_id: null, sent_at: null })
  assert.ok(progress()?.last_success_at, 'S: a full sync stamps the checkpoint')
  // Q: the fake-syncerror thread failed: no fresh checkpoint, freshness unknown, a send to that recipient holds
  assert.equal(progress(Q)?.last_outcome, 'failure'); assert.equal(progress(Q)?.last_success_at, null)
  assert.equal(replySafetyStale(db, Q, broken), true)
  assert.equal(sendBlockReason(db, Q, approvedTo(broken, Q), { skipAccount: true }), 'reply_sync_stale')
  // a second tick never ingests the same reply twice
  await call()
  assert.equal(inbound().length, 1)
})

test('#413 staging fake replies: the flag off keeps the stub reading nothing', async () => {
  delete process.env.DAZL_STAGING_FAKE_REPLIES
  const T = firstTouch('staging+fake-optout@later.example')
  db.prepare('DELETE FROM inbound_messages WHERE tenant_id = ?').run(S)
  await call()
  assert.deepEqual(inbound(), [], 'flag off: nothing read')
  assert.equal(isSuppressed(db, S, 'staging+fake-optout@later.example'), false)
  void T
})
