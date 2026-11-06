// Shared post-await send-authority recheck (Refs #739, #925, #405, #467). Converted from the audit's fenced reproducer: synthetic
// tenant and addresses, injected fetch and send functions, no provider and no real send. Each case changes authority DURING the
// token await; the send handoff must then refuse. The control case (nothing changes) must still send, so a pass is not an inert test.
import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, getSettings, isSuppressed, cleanBookingUrl } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, getState, migrateAutopilot, recentAutopilotAudit } from '../lib/outreach/autopilot.ts'
import { grantConsent, hasConsent, migrateLedger, revokeAll } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, classifyReply, migrateReplies, newText, syncReplies, threadMessages } from '../lib/outreach/replies.ts'
import { followupText, runFollowups, setFollowups } from '../lib/outreach/followups.ts'
import { inboxPage } from '../lib/outreach/inbox.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND}${withRead ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  acceptReadConsent(db, 'A')
  return db
}
function sentLead(db: Database.Database, to: string, sentAt = NOW - 4 * DAY) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Northside', to, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
const msg = (id: string, from: string, body: string, at: number, extra: { name: string; value: string }[] = []) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, ...extra], body: { data: Buffer.from(body).toString('base64url') } } })
function gmail(threads: Record<string, unknown[]>, calls: string[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] }) // no daemon notices in these fixtures
    return json({}, 404)
  }) as unknown as typeof fetch
}

const flags = { AUTOPILOT_ENABLED: '1' }
function sendSpy() { const sent: { raw: string; thread?: string }[] = []; return { sent, sendFn: (async (_t: string, raw: string, _f: unknown, thread?: string) => { sent.push({ raw, thread }); return { id: 'f1' } }) as never } }
const base = (over: object = {}) => ({ flags, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: gmail({}), ...over })

async function interested(db: Database.Database, to = 'p@one.example', repliedAt = NOW - 4 * DAY) {
  const s = sentLead(db, to)
  await syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail({ [s.thread]: [msg('r' + s.mid, to, 'Interested, tell me more', repliedAt)] }) })
  return s
}



for (const mode of ['control', 'disable', 'revoke', 'suppress', 'sender', 'unreadable'] as const) {
  test(`warm follow-up, authority ${mode === 'control' ? 'unchanged' : 'changed during the token await'}: ${mode === 'control' ? 'sends' : 'refused, no handoff, no sent record'}`, async () => {
    const db = await setup(); await interested(db); setFollowups(db, 'A', true)
    const spy = sendSpy(); const f = gmail({})
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('oauth2')) {
        if (mode === 'disable') db.prepare("UPDATE autopilot_settings SET enabled = 0 WHERE tenant_id = 'A'").run()
        if (mode === 'revoke') revokeAll(db, 'A', 'p@one.example', 'revoked', NOW)
        if (mode === 'suppress') db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('A', 'p@one.example', 'manual')").run()
        if (mode === 'sender') db.prepare("UPDATE gmail_accounts SET email = 'other@other.example' WHERE tenant_id = 'A'").run()
        if (mode === 'unreadable') db.exec('DROP TABLE suppressions')
      }
      return f(...args)
    }) as typeof fetch
    const r = await runFollowups(db, 'A', 'Acme', base({ sendFn: spy.sendFn, fetchImpl }))
    if (mode === 'control') { assert.equal(r.sent, 1); assert.equal(spy.sent.length, 1) }
    else {
      assert.equal(r.sent, 0); assert.equal(spy.sent.length, 0, 'no handoff')
      assert.equal((db.prepare("SELECT count(*) AS n FROM followup_messages WHERE status = 'sent'").get() as { n: number }).n, 0, 'no sent record')
      assert.equal((db.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0, 'claim released')
    }
    db.close()
  })
}
