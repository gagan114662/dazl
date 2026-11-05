// #413 acceptance through the real tick route (app/api/internal/tick/route.ts), run by test/first-touch-reply-tick.test.ts
// through the tenant-route loader. Unlike scheduler-tick-runtime.mts this runs in PRODUCTION mode (not staging), so
// syncReplies really opens threads - against a stubbed Gmail (global fetch replaced below; nothing leaves the process,
// the net fence stays behind it). Synthetic tenants and recipients only.
//   P  first-touch-only, sending PAUSED, follow-ups off, no sequence, read consent: its opt-out is ingested on tick
//      and nothing further can go to that recipient.
//   Q  never enabled sending at all, read consent; one thread errors at Gmail: the opt-out on the other thread is still
//      honoured, but the sync is a failure - no fresh checkpoint, and a send to a contacted recipient holds as stale.
//   R  autopilot ON and unpaused (so the tick selects it for send-side work), read consent REVOKED: zero Gmail reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { acceptReadConsent, revokeReadConsent } from '../../lib/outreach/replies.ts'
import { CONSENT_VERSION } from '../../lib/outreach/autopilot.ts'
import { createJob } from '../../lib/scan/store.ts'
import { replySafetyStale } from '../../lib/outreach/store.ts'
import { isSuppressed, saveSettings, sendBlockReason, sendMessage } from '../../lib/outreach/service.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

delete process.env.DAZL_ENV // production mode: the tick's syncReplies reads Gmail (here: the stub below)
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com'; process.env.GOOGLE_CLIENT_SECRET = 'synthetic'
process.env.AUTOPILOT_ENABLED = '1'
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'

// ---------- stubbed Google: token refresh + thread reads + the bounded daemon-notice search; anything else throws ----------
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const threads: Record<string, unknown[]> = {}
const broken = new Set<string>()
const calls: string[] = []
const fenced = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input)
  if (u.startsWith('https://oauth2.googleapis.com/token')) { calls.push(u); return json({ access_token: 'synthetic-at' }) }
  if (u.startsWith('https://gmail.googleapis.com/')) {
    calls.push(u)
    const m = u.match(/threads\/([^?]+)/)
    if (m) return broken.has(m[1]) ? json({ error: 'backend' }, 500) : json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] })
    throw new Error(`unexpected Gmail call in #413 harness: ${u}`) // e.g. a send: nothing in this harness may send
  }
  return fenced(input as never, init) // loopback only (the net fence throws on everything else)
}) as typeof fetch

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const now = () => Math.floor(Date.now() / 1000)
const P = 'tenant-p-paused-first-touch', Q = 'tenant-q-partial', R = 'tenant-r-revoked'
for (const t of [P, Q, R]) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(t, `${t}@example.test`, `${t} business`)
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  // connected mailbox with the read scope (the stub connect writes the same row a real OAuth grant with read does)
  startOAuth(db, t, { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never })
  acceptReadConsent(db, t)
}
// P: autopilot on but PAUSED, follow-ups OFF - neither send set selects it. R: autopilot on, unpaused, follow-ups on.
db.prepare('INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, consent_at, followups_enabled) VALUES (?, 1, 1, ?, ?, 0)').run(P, CONSENT_VERSION, now())
db.prepare('INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, consent_at, followups_enabled) VALUES (?, 1, 0, ?, ?, 1)').run(R, CONSENT_VERSION, now())

// A first touch that already went out (no sequence, no follow-up thread row: only the tick's reply read creates that).
function newLead(t: string, to: string) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, ?, 'Northside', ?, 'Hiring', 'https://n.example/a', 'Northside is hiring', 90, ?, 'test_review')").run(lead, job, to, now() - 5 * 86400)
  return lead
}
function firstTouch(t: string, to: string) {
  const lead = newLead(t, to), mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, t, lead, to, now() - 3 * 86400, now() - 3 * 86400, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
// A further approved email to the same recipient (what a later drain, follow-up or manual send would try): one
// message per lead, so it is a second lead naming the same address.
function approvedTo(t: string, to: string) {
  const lead = newLead(t, to), id = randomBytes(12).toString('hex'), subject = 'Following up', body = 'bodybodybodybodybodybody two'
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, approved_hash) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)").run(id, t, lead, to, subject, body, createHash('sha256').update(JSON.stringify([to, subject, body])).digest('hex'))
  return id
}
const reply = (id: string, from: string, text: string) => ({ id, threadId: 't', internalDate: String((now() - 86400) * 1000), payload: { mimeType: 'text/plain', body: { data: b64(text) }, headers: [{ name: 'From', value: from }] } })
const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))).json()
const progress = (t: string, k: string) => db.prepare('SELECT last_success_at, last_outcome, last_hold, consecutive_failures FROM scheduler_progress WHERE tenant_id = ? AND kind = ?').get(t, k) as { last_success_at: number | null; last_outcome: string; last_hold: string | null; consecutive_failures: number } | undefined
const cls = (t: string, id: string) => (db.prepare('SELECT classification FROM inbound_messages WHERE tenant_id = ? AND gmail_id = ?').get(t, id) as { classification: string } | undefined)?.classification
const stopped = (t: string, thread: string) => (db.prepare('SELECT stopped FROM followup_threads WHERE tenant_id = ? AND thread_id = ?').get(t, thread) as { stopped: string | null } | undefined)?.stopped
const read = (thread: string) => calls.filter(u => u.includes(`threads/${thread}`)).length

const p1 = firstTouch(P, 'sam@buyer.example'), p2 = firstTouch(P, 'kim@other.example')
const q1 = firstTouch(Q, 'lee@third.example'), q2 = firstTouch(Q, 'ana@fourth.example')
const r1 = firstTouch(R, 'max@fifth.example')
threads[p1.thread] = [reply('p1-r', 'Sam <sam@buyer.example>', 'Please unsubscribe me, thanks.')]
threads[q1.thread] = [reply('q1-r', 'Lee <lee@third.example>', 'Stop emailing me.')]
threads[r1.thread] = [reply('r1-r', 'Max <max@fifth.example>', 'Remove me from your list.')]
broken.add(q2.thread)
revokeReadConsent(db, R) // R turned reply reading off before the tick

test('#413 first-touch-only reply/opt-out reading on the scheduled tick: paused sending, never-enabled sending, partial sync, revoked read consent', async () => {
  const r = await call()
  assert.equal(r.ok, true)

  // P: paused, follow-ups off, no sequence - its first-touch thread was read on the tick and the opt-out honoured
  assert.ok(read(p1.thread) >= 1 && read(p2.thread) >= 1, 'every recent first-touch thread of P was opened')
  assert.equal(cls(P, 'p1-r'), 'opt_out')
  assert.equal(isSuppressed(db, P, 'sam@buyer.example'), true)
  assert.equal(stopped(P, p1.thread), 'opt_out'); assert.equal(stopped(P, p2.thread), null)
  assert.ok(progress(P, 'reply_sync')?.last_success_at, 'P has a fresh, full reply-sync checkpoint')
  assert.equal(progress(P, 'followups'), undefined); assert.equal(progress(P, 'first_touch'), undefined, 'paused: no send-side work ran')
  // no further email to the opted-out recipient - also once sending resumes
  db.prepare('UPDATE autopilot_settings SET paused = 0 WHERE tenant_id = ?').run(P)
  const again = approvedTo(P, 'sam@buyer.example')
  assert.equal(sendBlockReason(db, P, again, { skipAccount: true }), 'suppressed')
  await assert.rejects(sendMessage(db, P, again), (e: Error & { code?: string }) => e.code === 'suppressed')
  assert.deepEqual(db.prepare('SELECT status, gmail_id, sent_at FROM outreach_messages WHERE id = ?').get(again), { status: 'skipped', gmail_id: null, sent_at: null }, 'refused for good, never sent')
  db.prepare('UPDATE autopilot_settings SET paused = 1 WHERE tenant_id = ?').run(P)

  // Q: never enabled sending; one thread failed at Gmail. The other thread's opt-out still landed, but the sync is a
  // failure: no checkpoint, freshness unknown, and a send to a contacted recipient holds as stale.
  assert.equal(cls(Q, 'q1-r'), 'opt_out'); assert.equal(isSuppressed(db, Q, 'lee@third.example'), true)
  assert.equal(progress(Q, 'reply_sync')?.last_outcome, 'failure'); assert.equal(progress(Q, 'reply_sync')?.last_success_at, null)
  assert.equal(replySafetyStale(db, Q, 'ana@fourth.example'), true, 'partial sync: freshness unknown')
  const qAgain = approvedTo(Q, 'ana@fourth.example')
  assert.equal(sendBlockReason(db, Q, qAgain, { skipAccount: true }), 'reply_sync_stale')

  // R: selected for send-side work (autopilot on), but read consent revoked: zero Gmail reads, recorded as a hold
  assert.equal(read(r1.thread), 0, 'revoked read consent: no thread read')
  assert.equal(cls(R, 'r1-r'), undefined)
  assert.equal(progress(R, 'reply_sync')?.last_outcome, 'hold'); assert.equal(progress(R, 'reply_sync')?.last_hold, 'reading_not_enabled')
  // exactly one token refresh per tenant that actually read (P and Q), none for R; nothing but reads/notice search hit Gmail
  assert.equal(calls.filter(u => u.includes('oauth2')).length, 2)
  assert.ok(calls.filter(u => u.includes('gmail.googleapis.com')).every(u => u.includes('/threads/') || (u.includes('messages?q=') && u.includes('mailer-daemon'))))

  // Q's broken thread recovers: the next tick records a full sync, freshness returns; R still reads nothing
  broken.delete(q2.thread)
  const before = calls.length
  await call()
  assert.ok(progress(Q, 'reply_sync')?.last_success_at, 'full sync stamps the checkpoint')
  assert.equal(replySafetyStale(db, Q, 'ana@fourth.example'), false)
  assert.equal(read(r1.thread), 0)
  assert.equal(calls.slice(before).filter(u => u.includes('oauth2')).length, 2, 'R still makes no provider call')
  // revoking P's consent too stops P's reads on the next tick
  revokeReadConsent(db, P)
  const before2 = calls.length
  await call()
  assert.equal(calls.slice(before2).filter(u => u.includes(p1.thread) || u.includes(p2.thread)).length, 0)
  assert.equal(calls.slice(before2).filter(u => u.includes('oauth2')).length, 1, 'only Q still reads')
})
