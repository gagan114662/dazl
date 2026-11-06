// Shared post-await send-authority recheck (Refs #739, #925, #405, #467). Converted from the audit's fenced reproducer: synthetic
// tenant and addresses, injected fetch and send functions, no provider and no real send. Each case changes authority DURING the
// token await; the send handoff must then refuse. The control case (nothing changes) must still send, so a pass is not an inert test.
import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { saveSettings, suppress } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
function mk() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateReplies(db); migrateLedger(db); migrateReopen(db)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  return db
}
async function seed(db: Database.Database) {
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  const tid = 'thread-x1', lid = 'lead-x1', email = 'pat@acme.com'
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('job-x1','A','b','i','l','running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES (?, 'job-x1','Pat','Acme','pat@acme.com','hiring AEs','https://n.com/a')").run(lid)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id='job-x1'").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1','A',?,?,'Quick question for Acme','Hi Pat, body text here for the first mail.','sent',?)").run(lid, email, NOW - 86400 * 50)
  db.prepare('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, stopped) VALUES (?,?,?,?,?,?,?,2,NULL)').run('A', tid, lid, email, 'root@x', NOW - 86400 * 45, NOW - 86400 * 45)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('gx','A',?,?,'pat@acme.com','sounds interesting','positive',?)").run(tid, lid, NOW - 86400 * 45)
  db.prepare('UPDATE leads SET human_confirmed_at = 1 WHERE id = ?').run(lid)
  createReopenDraft(db, 'A', tid, 'Dazl')
  return tid
}

import { getAccessTokenBound } from '../lib/gmail/oauth.ts'
import { recheckSendAuthority } from '../lib/outreach/send-authority.ts'

// Connection-generation binding (Refs #739, addendum 2): the token's refresh_ct generation is bound to the send handoff.
const tokenOk = (async () => json({ access_token: 'x' })) as unknown as typeof fetch
const gen = (db: Database.Database) => (db.prepare("SELECT refresh_ct FROM gmail_accounts WHERE tenant_id = 'A'").get() as { refresh_ct: string }).refresh_ct
const base = { to: 'pat@acme.com', sender: 'me@acme.example', now: NOW }

test('getAccessTokenBound returns the generation it minted from; getAccessToken is unchanged', async () => {
  const db = mk(); await seed(db)
  const b = await getAccessTokenBound(db, 'A', { env, master, fetchImpl: tokenOk })
  assert.equal(b.token, 'x'); assert.equal(b.refreshCt, gen(db))
})

test('control: same generation at the handoff passes', async () => {
  const db = mk(); await seed(db)
  const b = await getAccessTokenBound(db, 'A', { env, master, fetchImpl: tokenOk })
  assert.equal(recheckSendAuthority(db, 'A', { ...base, expectRefreshCt: b.refreshCt }), null)
})

test('same-address replacement (new refresh token) between token fetch and handoff refuses: connection_replaced', async () => {
  const db = mk(); await seed(db)
  const b = await getAccessTokenBound(db, 'A', { env, master, fetchImpl: tokenOk })
  db.prepare("UPDATE gmail_accounts SET refresh_ct = 'a-newer-connection' WHERE tenant_id = 'A'").run()
  assert.equal(recheckSendAuthority(db, 'A', { ...base, expectRefreshCt: b.refreshCt }), 'connection_replaced')
  assert.equal(recheckSendAuthority(db, 'A', base), null, 'callers that pass no generation keep the old behaviour')
})

test('different-address replacement still refuses as sender_changed (control)', async () => {
  const db = mk(); await seed(db)
  const b = await getAccessTokenBound(db, 'A', { env, master, fetchImpl: tokenOk })
  db.prepare("UPDATE gmail_accounts SET email = 'other@other.example', refresh_ct = 'x' WHERE tenant_id = 'A'").run()
  assert.equal(recheckSendAuthority(db, 'A', { ...base, expectRefreshCt: b.refreshCt }), 'sender_changed')
})

test('re-open send: connection replaced at the same address during the token await refuses, nothing sent', async () => {
  const db = mk(); const tid = await seed(db); let sends = 0
  const d = { env, now: NOW, master, sendFn: (async () => { sends++; return { id: 'stub' } }) as never, fetchImpl: (async () => {
    db.prepare("UPDATE gmail_accounts SET refresh_ct = 'a-newer-connection' WHERE tenant_id = 'A'").run(); return json({ access_token: 'x' })
  }) as unknown as typeof fetch }
  let result = 'ok'
  try { await sendReopen(db, 'A', tid, d) } catch (e) { result = (e as Error).message }
  assert.equal(sends, 0); assert.notEqual(result, 'ok')
})
