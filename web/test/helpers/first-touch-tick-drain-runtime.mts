// #411 acceptance through the real tick route (app/api/internal/tick/route.ts), run by test/first-touch-tick-drain.test.ts
// through the tenant-route loader. The lib-level legs live in first-touch-drain.test.ts; this proves the SCHEDULER is
// what drains held first touches - no scan, no manual action - in staging mode (Gmail is the stub: nothing is sent or
// fetched; the network is fenced). The clock is Date.now, moved forward by the test. Synthetic tenants only.
//   D  autopilot on (explicit consent, warm-up done), daily cap 1, two candidate leads: one sends, one holds as
//      daily_cap work; ticks before the due time send nothing; two concurrent ticks after it send exactly one; then
//      a process restart (a fresh handle on the same file store) finds nothing left to send.
//   P  same, but paused before the due time: no send while paused; resumed, the held work goes out once.
//   X  same, but its mailbox disconnected before the due time: nothing goes out; reconnected, the held work resumes.
//   W  warm-up NOT done (manual approval policy): the draft is never auto-sent by any tick.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { seedOffers } from './seed-offer.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { disconnectGmail, startOAuth } from '../../lib/gmail/oauth.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, pause, resume } from '../../lib/outreach/autopilot.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { createJob } from '../../lib/scan/store.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
process.env.AUTOPILOT_ENABLED = '1'
process.env.AUTOPILOT_WARMUP = '2'
delete process.env.AUTOPILOT_KILL; delete process.env.SEQUENCES_ENABLED

// The clock the route and every worker read (Math.floor(Date.now() / 1000)).
const T0 = 1_800_000_000, DAY = 86400
let clock = T0
Date.now = () => clock * 1000

const dir = mkdtempSync(join(tmpdir(), 'dazl-411-'))
const file = join(dir, 'store.db')
let db = new Database(file)
migrateAllSqlite(db)
setScanDb(db)
const env = { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never
const D = 'tenant-d-daily', P = 'tenant-p-paused', X = 'tenant-x-reconnect', W = 'tenant-w-warmup'
seedOffers(db, [D, P, X, W])
for (const t of [D, P, X, W]) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(t, `${t}@example.test`, `${t} business`)
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  startOAuth(db, t, { env }) // staging: the stub mailbox is connected straight away
  enable(db, t, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 })
}
// Two old approved warm-up sends (outside every cap window) clear the manual warm-up gate for D, P and X; W has none.
for (const t of [D, P, X]) for (const n of [1, 2]) {
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)")
    .run(randomBytes(12).toString('hex'), t, `warm-${n}`, `o${n}@warm.example`, T0 - 9e5, T0 - 9e5)
}
// A confirmed lead of a FINISHED scan: autopilot's candidate (no message row yet).
function lead(t: string, contact: string) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80, ?, 'test_review')")
    .run(id, job, 'Co ' + id.slice(0, 4), contact, T0 - DAY)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return id
}
for (const t of [D, P, X]) { lead(t, `a@one-${t}.example`); lead(t, `b@two-${t}.example`) }
lead(W, 'c@three-w.example')

const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))).json()
const real = (t: string) => db.prepare("SELECT id, to_email, status, gmail_id FROM outreach_messages WHERE tenant_id = ? AND to_email NOT LIKE '%@warm.example' ORDER BY to_email").all(t) as { id: string; to_email: string; status: string; gmail_id: string | null }[]
const sent = (t: string) => real(t).filter(m => m.status === 'sent').length
const work = (t: string) => db.prepare('SELECT w.reason, w.next_at FROM autopilot_work w JOIN outreach_messages m ON m.id = w.message_id WHERE w.tenant_id = ? AND m.status = ?').all(t, 'draft') as { reason: string; next_at: number }[]

test('#411 the scheduled tick drains held first touches: due-time lift, two concurrent ticks, pause, reconnect, restart, warm-up', async () => {
  try {
    // Tick 1 (no scan finished just now): the cap of 1 lets one first touch go; the other is held as work, due a day on.
    const r1 = await call()
    assert.equal(r1.ok, true)
    for (const t of [D, P, X]) {
      assert.equal(sent(t), 1, `${t}: one first touch within the cap`)
      const held = work(t)
      assert.equal(held.length, 1, `${t}: the second is kept as first-touch work, not stranded`)
      assert.equal(held[0].reason, 'daily_cap'); assert.ok(held[0].next_at > T0 && held[0].next_at <= T0 + DAY + 1)
    }
    assert.equal(sent(W), 0, 'warm-up not done: nothing auto-sent')
    assert.equal(real(W).filter(m => m.status === 'draft').length, 1, 'W: drafted for the user to approve')

    // Before the due time: a later tick sends nothing and drafts nothing new.
    clock = T0 + 3600
    await call()
    for (const t of [D, P, X]) { assert.equal(sent(t), 1); assert.equal(real(t).length, 2) }

    // P pauses and X disconnects its mailbox before the window rolls.
    pause(db, P, 'paused_by_user')
    await disconnectGmail(db, X, { env })

    // After the due time: two ticks at once. D's held draft goes out exactly once - no scan, no manual action.
    clock = T0 + DAY + 60
    const both = await Promise.all([call(), call()])
    assert.ok(both.some(b => b.ok === true), 'one of the concurrent ticks ran')
    assert.equal(sent(D), 2, 'D: the held first touch was sent at its due time')
    assert.equal(new Set(real(D).map(m => m.gmail_id)).size, 2, 'D: two distinct sends, never the same draft twice')
    assert.equal(sent(P), 1, 'P: paused - the drain sends nothing')
    assert.equal(sent(X), 1, 'X: mailbox disconnected - nothing goes out')
    assert.equal(sent(W), 0, 'W: still never auto-sent')
    await call()
    assert.equal(sent(D), 2, 'D: a further tick does not resend')

    // Restart: a fresh handle on the same store. P resumed, X reconnected: each held draft goes out once; D has nothing left.
    db.close()
    db = new Database(file)
    setScanDb(db)
    resume(db, P)
    startOAuth(db, X, { env })
    clock = T0 + DAY + 600
    await call()
    assert.equal(sent(D), 2, 'D: nothing resent after the restart')
    assert.equal(sent(P), 2, 'P: resumed - its held first touch went out')
    assert.equal(sent(X), 2, 'X: reconnected - its held first touch resumed')
    await call()
    for (const t of [D, P, X]) assert.equal(sent(t), 2, `${t}: exactly two first touches, no duplicate`)
    assert.equal(sent(W), 0, 'W: warm-up drafts never auto-sent, across a restart')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
