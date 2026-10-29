// #164: the Follow-ups page promises a next date only when the follow-up runner would actually send (lib/outreach/
// followups.ts accountHold/threadHold, the runner's own checks in its own order). Configuration (scheduled_at) and the
// real schedule (next_due_at) are both shown; a held thread says why. Read-only: no automation or consent changes,
// no provider calls, no sends. Synthetic fixtures; SQLite and Postgres; tenant-scoped.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { followupOverview, GAPS_DAYS } from '../lib/outreach/followups.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { CONSENT_VERSION, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { bothEngines } from './helpers/engines.ts'

// Instinct's exact reproduction on PR #164 (current main bd8), verbatim apart from formatting.
const setupReview = () => {
  const db = new Database(':memory:')
  migrateAutopilot(db); migrateReplies(db); migrateOutreach(db); migrateConnectors(db)
  db.exec("CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT); CREATE TABLE leads (id TEXT PRIMARY KEY, scan_job_id TEXT, company TEXT, name TEXT)")
  db.prepare("INSERT INTO scan_jobs VALUES ('j1', 't1')").run()
  db.prepare("INSERT INTO leads VALUES ('l1', 'j1', 'Invented Robotics', 'Invented Person')").run()
  db.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, followups_enabled) VALUES ('t1', 1, 1)").run()
  return db
}
test('REVIEW disabled followups must not display a promised next date', async () => {
  const db = setupReview(); const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE autopilot_settings SET enabled=0, followups_enabled=0 WHERE tenant_id='t1'").run()
  db.prepare("INSERT INTO followup_threads VALUES ('t1','synthetic-thread','l1','invented@example.test','root',?,?,0,NULL,NULL)").run(now - 86400, now - 86400)
  const o = await followupOverview(sqliteDb(db), 't1'); assert.equal(o.enabled, false); assert.equal(o.threads[0].next_due_at, null)
})

const NOW = 1_800_000_000, DAY = 86400
const FLAGS = { AUTOPILOT_ENABLED: '1' }
// A tenant for whom the runner would send: autopilot on with current consent, follow-ups on, Gmail and sender identity
// set, nothing uncertain, a thread with an interested reply and a valid follow-up consent for its address.
async function ready(db: Db, t: string, n = 1) {
  await db.run("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, followups_enabled) VALUES (?, 1, 0, ?, 1)", [t, CONSENT_VERSION])
  await db.run("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES (?, ?, 'ct', 'active')", [t, `me@${t}.example`])
  await db.run("INSERT INTO outreach_settings (tenant_id, sender_name, postal_address) VALUES (?, 'Pat', '1 King St W, Toronto ON')", [t])
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [`job-${t}`, t])
  for (let i = 1; i <= n; i++) {
    await db.run("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, 's', 'https://n.example/a', 'q', 80)", [`lead-${t}-${i}`, `job-${t}`, `Co ${i}`, `sam${i}@buyer.example`])
    await db.run("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES (?, ?, ?, ?, 'root', ?, ?, 0)", [t, `th-${t}-${i}`, `lead-${t}-${i}`, `sam${i}@buyer.example`, NOW - DAY, NOW - DAY])
    await db.run("INSERT INTO consent_ledger (id, tenant_id, contact, channel, scope, basis, evidence_ref, granted_at, expires_at) VALUES (?, ?, ?, 'email', 'followup', 'reply_interest', 'gmail:x', ?, ?)", [`c-${t}-${i}`, t, `sam${i}@buyer.example`, NOW - DAY, NOW + 90 * DAY])
  }
}
const view = (db: Db, t: string) => followupOverview(db, t, { flags: FLAGS, now: NOW })
const due = NOW - DAY + GAPS_DAYS[0] * DAY

bothEngines('a ready thread is promised its date; each account-wide hold removes it and says why, keeping the configured date', async ({ db }) => {
  await ready(db, 'ta')
  let o = await view(db, 'ta')
  assert.deepEqual([o.hold, o.threads[0].hold, o.threads[0].scheduled_at, o.threads[0].next_due_at], [null, null, due, due])
  const holds: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ['followups_off', () => db.run("UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = 'ta'"), () => db.run("UPDATE autopilot_settings SET followups_enabled = 1 WHERE tenant_id = 'ta'")],
    ['autopilot_off', () => db.run("UPDATE autopilot_settings SET enabled = 0 WHERE tenant_id = 'ta'"), () => db.run("UPDATE autopilot_settings SET enabled = 1 WHERE tenant_id = 'ta'")],
    ['autopilot_paused', () => db.run("UPDATE autopilot_settings SET paused = 1 WHERE tenant_id = 'ta'"), () => db.run("UPDATE autopilot_settings SET paused = 0 WHERE tenant_id = 'ta'")],
    ['consent_outdated', () => db.run("UPDATE autopilot_settings SET consent_version = '2000-01-01' WHERE tenant_id = 'ta'"), () => db.run('UPDATE autopilot_settings SET consent_version = ? WHERE tenant_id = ?', [CONSENT_VERSION, 'ta'])],
    ['gmail_or_identity', () => db.run("UPDATE gmail_accounts SET status = 'needs_reconnect' WHERE tenant_id = 'ta'"), () => db.run("UPDATE gmail_accounts SET status = 'active' WHERE tenant_id = 'ta'")],
    ['gmail_or_identity', () => db.run("DELETE FROM outreach_settings WHERE tenant_id = 'ta'"), () => db.run("INSERT INTO outreach_settings (tenant_id, sender_name, postal_address) VALUES ('ta', 'Pat', '1 King St W, Toronto ON')")],
    ['uncertain_send', () => db.run("INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES ('ta', 'th-ta-1', 0, 'uncertain', ?)", [NOW - DAY]), () => db.run("DELETE FROM followup_messages WHERE tenant_id = 'ta'")],
  ]
  for (const [why, hold, undo] of holds) {
    await hold()
    o = await view(db, 'ta')
    assert.deepEqual([o.hold, o.threads[0].hold, o.threads[0].scheduled_at, o.threads[0].next_due_at], [why, why, due, null], why)
    await undo()
  }
  assert.equal((await followupOverview(db, 'ta', { flags: {}, now: NOW })).threads[0].next_due_at, null, 'autopilot not available on this server')
  assert.equal((await followupOverview(db, 'ta', { flags: {}, now: NOW })).hold, 'not_available')
  assert.equal((await view(db, 'ta')).threads[0].next_due_at, due, 'every hold undone: the date is back')
})

bothEngines('thread holds: owned by a sequence, suppressed, or no valid follow-up consent', async ({ db }) => {
  await ready(db, 'tb', 4)
  await db.run("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email) VALUES ('sq1', 'tb', 'lead-tb-1', 'm1', 'sam1@buyer.example')")
  await db.run("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('tb', 'sam2@buyer.example', 'unsubscribe')")
  await db.run("UPDATE consent_ledger SET revoked_at = ? WHERE id = 'c-tb-3'", [NOW - 1])
  const o = await view(db, 'tb')
  const by = Object.fromEntries(o.threads.map(t => [t.thread_id, [t.hold, t.next_due_at, t.scheduled_at]]))
  assert.deepEqual(by, { 'th-tb-1': ['sequence', null, due], 'th-tb-2': ['suppressed', null, due], 'th-tb-3': ['no_consent', null, due], 'th-tb-4': [null, due, due] })
  assert.equal(o.hold, null)
  // an expired consent is no consent either
  await db.run('UPDATE consent_ledger SET expires_at = ? WHERE id = ?', [NOW - 1, 'c-tb-4'])
  assert.equal((await view(db, 'tb')).threads.find(t => t.thread_id === 'th-tb-4')!.hold, 'no_consent')
})

bothEngines('tenant-scoped: another tenant\'s holds, consent and threads never change this tenant\'s schedule', async ({ db }) => {
  await ready(db, 'tc'); await ready(db, 'td')
  await db.run("UPDATE autopilot_settings SET paused = 1 WHERE tenant_id = 'td'")
  await db.run("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('td', 'sam1@buyer.example', 'unsubscribe')")
  await db.run("UPDATE consent_ledger SET revoked_at = ? WHERE tenant_id = 'td'", [NOW - 1])
  const c = await view(db, 'tc'), d = await view(db, 'td')
  assert.deepEqual(c.threads.map(t => [t.thread_id, t.hold, t.next_due_at]), [['th-tc-1', null, due]])
  assert.deepEqual(d.threads.map(t => [t.thread_id, t.hold, t.next_due_at]), [['th-td-1', 'autopilot_paused', null]])
})
