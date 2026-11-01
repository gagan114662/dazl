// Caller-level malformed-success matrices (refs #435), preserved from the independent
// review probe: injected-transport malformed Gmail "success" payloads at the two callers
// the shipped matrices did not cover - service.sendMessage and runFollowups.
// (Shipped matrices already cover sequences.test.ts and reopen-send-claim.test.ts.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { startOAuth, completeOAuth } from '../lib/gmail/oauth.ts'
import { approve, createDraft, saveSettings, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { runFollowups, GAPS_DAYS } from '../lib/outreach/followups.ts'
import { CONSENT_VERSION } from '../lib/outreach/autopilot.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000, DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at-1' }) : json({}, 404))) as unknown as typeof fetch
const BADS = [undefined, null, {}, { id: '' }, { id: '   ' }, { id: 7 }, { id: ['x'] }, { threadId: 'th1' }]

function connect(db: Database.Database, tenant: string) {
  const state = new URL(startOAuth(db, tenant, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, tenant, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-1', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y' })) as unknown as typeof fetch })
}
function addLeadSvc(db: Database.Database, tenant: string) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Northside Builders', 'info@northside.example', 'Hiring five roofers', 'https://news.example/a', 'Northside Builders is hiring five roofers', 85)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=?").run(id)
  return id
}

test('PROBE service.sendMessage: malformed success -> uncertain + paused + error, no retry', async () => {
  for (const bad of BADS) {
    const db = new Database(':memory:')
    migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db); migrateAutopilot(db)
    db.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version) VALUES ('A', 1, 0, ?)").run(CONSENT_VERSION)
    await connect(db, 'A')
    saveSettings(db, 'A', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
    const id = createDraft(db, 'A', addLeadSvc(db, 'A'), 'Acme'); approve(db, 'A', id)
    let calls = 0
    const sendFn = (async () => { calls++; return bad }) as never
    const deps: Deps = { env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn }
    const r = await sendMessage(db, 'A', id, deps)
    assert.equal(r, 'uncertain', JSON.stringify(bad))
    const row = db.prepare('SELECT status, error, gmail_id FROM outreach_messages WHERE id = ?').get(id) as { status: string; error: string; gmail_id: string | null }
    assert.deepEqual(row, { status: 'uncertain', error: 'send_outcome_unknown', gmail_id: null })
    const ap = db.prepare('SELECT paused, pause_reason FROM autopilot_settings WHERE tenant_id = ?').get('A') as { paused: number; pause_reason: string }
    assert.deepEqual(ap, { paused: 1, pause_reason: 'uncertain_send' })
    await assert.rejects(sendMessage(db, 'A', id, deps), /already_uncertain/)
    assert.equal(calls, 1, 'no blind retry')
    db.close()
  }
})

test('PROBE runFollowups: malformed success -> uncertain + paused, thread stopped, no retry', async () => {
  for (const bad of BADS) {
    const raw = new Database(':memory:'); migrateAllSqlite(raw)
    const t = 'tr'
    raw.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, followups_enabled) VALUES (?, 1, 0, ?, 1)").run(t, CONSENT_VERSION)
    raw.prepare("INSERT INTO outreach_settings (tenant_id, sender_name, postal_address) VALUES (?, 'Pat', '1 King St W, Toronto ON')").run(t)
    raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')").run(`job-${t}`, t)
    raw.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, 's', 'https://n.example/a', 'q', 80)").run(`lead-${t}-1`, `job-${t}`, 'Co 1', 'sam1@buyer.example')
    raw.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=?").run(`lead-${t}-1`)
    raw.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES (?, ?, ?, ?, 'root', ?, ?, 0)").run(t, `th-${t}-1`, `lead-${t}-1`, 'sam1@buyer.example', NOW - 4 * DAY, NOW - 4 * DAY)
    raw.prepare("INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES (?, ?, ?, 'email', 'followup', 'reply_interest', 'gmail:x', ?, ?)").run(`c-${t}-1`, t, 'sam1@buyer.example', NOW - DAY, NOW + 90 * DAY)
    raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES (?, ?, ?, ?, 'Intro', 'Thanks for the earlier conversation note.', 'sent', ?)").run(`orig-${t}-1`, t, `lead-${t}-1`, 'sam1@buyer.example', NOW - 4 * DAY)
    await connect(raw, t)
    let calls = 0
    const d = { env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, flags: { AUTOPILOT_ENABLED: '1' }, sendFn: (async () => { calls++; return bad }) as never }
    const r1 = await runFollowups(raw, t, 'Biz', d)
    assert.equal(r1.stopped, 'uncertain_send', JSON.stringify(bad))
    const fm = raw.prepare('SELECT status, gmail_id FROM followup_messages WHERE tenant_id = ?').get(t) as { status: string; gmail_id: string | null }
    assert.deepEqual(fm, { status: 'uncertain', gmail_id: null })
    const ap = raw.prepare('SELECT paused, pause_reason FROM autopilot_settings WHERE tenant_id = ?').get(t) as { paused: number; pause_reason: string }
    assert.deepEqual(ap, { paused: 1, pause_reason: 'uncertain_send' })
    const r2 = await runFollowups(raw, t, 'Biz', d)
    assert.equal(r2.sent, 0)
    assert.equal(calls, 1, 'no blind retry')
    raw.close()
  }
})
