// #1805 (#1604 E1): the daily send limit, in plain words. When the cap is hit the user sees how many
// went out today and when the rest go out — the reset instant in their own timezone, falling back to
// America/Toronto — never the raw daily_cap code; and queued sends stay queued, not failed, on both
// the manual path (Toronto-day cap, resets at the next Toronto midnight) and the sequence path
// (rolling 24-hour account cap). The builder is the one the Outreach page renders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot, enable, CONSENT_VERSION, ATTESTATIONS } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { approve, saveSettings, sendCapToday, sendMessage } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'
import { sendDayStart } from '../lib/outreach/send-budget.ts'
import { dailyCapMessage } from '../lib/outreach/send-cap-copy.ts'

const NOW = 1_800_000_000, DAY = 86400 // 2027-01-15 08:00 UTC, 03:00 in Toronto
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 25 })
  acceptReadConsent(db, 'A')
  return db
}

function addDraft(db: Database.Database, email: string) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Acme', email, 'Hiring roofers', 'https://acme.example/jobs', 'Acme is hiring roofers', 90)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=?").run(lead)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES (?, 'A', ?, ?, 'A quick question', 'This is a draft message for review.')").run(mid, lead, email)
  return { lead, mid }
}

function mock() {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) return json({ access_token: 'access' })
    if (url.includes('/threads/')) return json({ messages: [] })
    if (url.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { calls.push(raw); return { id: `gm${calls.length}`, threadId: 'thread-1' } }) as never
  return { calls, fetchImpl, sendFn, env, master, now: NOW, baseUrl: 'https://app.test', flags: { SEQUENCES_ENABLED: '1', AUTOPILOT_AVAILABLE: '1', AUTOPILOT_ENABLED: '1' } }
}

test('the message: count, reset time in the reader timezone, Toronto fallback, nothing raw', () => {
  const resetsAt = sendDayStart(NOW) + DAY // the next Toronto midnight: 2027-01-16 05:00 UTC
  assert.equal(dailyCapMessage(40, resetsAt, 'America/Toronto', NOW), "You've sent today's 40 emails. You can send the rest after midnight.", 'a reset at the reader midnight reads as after midnight, not 12:00 AM')
  assert.equal(dailyCapMessage(40, resetsAt, 'America/Vancouver', NOW), "You've sent today's 40 emails. You can send the rest today at 10:00 PM.", 'the same instant, in the reader timezone: still today there (BC is on permanent daylight time in the 2026 tz database, UTC-7 year-round)')
  assert.equal(dailyCapMessage(40, resetsAt, undefined, NOW), "You've sent today's 40 emails. You can send the rest after midnight.", 'no timezone falls back to America/Toronto')
  assert.equal(dailyCapMessage(40, resetsAt, 'Bogus/Zone', NOW), "You've sent today's 40 emails. You can send the rest after midnight.", 'an unreadable timezone falls back too, never throws')
  assert.equal(dailyCapMessage(40, null, 'America/Toronto', NOW), "You've sent today's 40 emails. You can send the rest tomorrow.", 'no reset instant: still plain, no invented time')
  for (const tz of ['America/Toronto', 'America/Vancouver', undefined, 'Bogus/Zone']) assert.ok(!dailyCapMessage(40, resetsAt, tz, NOW).includes('daily_cap'), 'the raw code never reaches the user')
})

test('the manual cap: the next send refuses plainly and the draft stays queued', async () => {
  const db = await setup()
  const m = mock()
  const { cap } = sendCapToday(db, 'A', NOW)
  assert.equal(cap, 20, 'a new account starts at 20 a day')
  for (let i = 0; i < cap; i++) {
    const { mid } = addDraft(db, `lead${i}@acme.example`)
    approve(db, 'A', mid)
    assert.equal(await sendMessage(db, 'A', mid, m), 'sent')
  }
  assert.deepEqual(sendCapToday(db, 'A', NOW), { cap, sent_today: cap })
  const extra = addDraft(db, 'extra@acme.example')
  approve(db, 'A', extra.mid)
  await assert.rejects(sendMessage(db, 'A', extra.mid, m), /daily_cap/)
  const row = db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(extra.mid) as { status: string; error: string | null }
  assert.deepEqual(row, { status: 'approved', error: 'daily_cap' }, 'queued for tomorrow, not failed, not skipped, not lost')
  assert.equal(m.calls.length, cap, 'nothing beyond the cap reached Gmail')
})

test('the sequence cap: a due step at the rolling cap stays queued and the sequence stays alive', async () => {
  const db = await setup()
  const m = mock()
  const first = addDraft(db, 'lead@acme.example')
  const seq = createSequence(db, 'A', first.mid)
  approveSequence(db, 'A', seq, (id) => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', first.mid, { ...m, now: NOW })
  assert.equal((await runSequences(db, 'A', 'Acme', { ...m, now: NOW })).started, 1)
  // Fill the rolling 24-hour account budget (20) with manual sends, then make step 2 due at the same instant.
  for (let i = 0; i < 19; i++) {
    const { mid } = addDraft(db, `other${i}@acme.example`)
    approve(db, 'A', mid)
    assert.equal(await sendMessage(db, 'A', mid, { ...m, now: NOW }), 'sent')
  }
  db.prepare('UPDATE outreach_messages SET sent_at = ? WHERE id = ?').run(NOW - 3 * DAY, first.mid)
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW })
  assert.equal(r.sent, 0, 'the due step does not send past the cap')
  assert.equal(r.stopped, 'daily_cap')
  assert.equal((db.prepare('SELECT status FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seq) as { status: string }).status, 'approved', 'the step stays queued for when the budget frees up')
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'active', 'the sequence is not stopped or failed by the cap')
})
