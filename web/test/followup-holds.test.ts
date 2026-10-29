// #164: the Follow-ups page promises a next date only when the follow-up runner would actually send (lib/outreach/
// followups.ts accountHold/threadHold, the runner's own checks in its own order). Configuration (scheduled_at) and the
// real schedule (next_due_at) are both shown; a held thread says why. Read-only: no automation or consent changes,
// no provider calls, no sends. Synthetic fixtures; SQLite and Postgres; tenant-scoped.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { followupOverview, GAPS_DAYS, runFollowups } from '../lib/outreach/followups.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
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

// Instinct's HOLD on e4f5b85: a follow-up claim left 'sending' past the runner's 600s boundary pauses the account in
// runFollowups, so the page must not promise a date. Same boundary (created_at < now - 600), same tenant scope.
const claim = (db: Db, t: string, age: number, status = 'sending') =>
  db.run('INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES (?, ?, 0, ?, ?)', [t, `th-${t}-1`, status, NOW - age])
bothEngines('a stale sending claim holds every thread like the runner (599/600 no, 601 yes), read-only, other tenants untouched', async ({ db }) => {
  await ready(db, 'te'); await ready(db, 'tf')
  for (const [age, want] of [[599, null], [600, null], [601, 'uncertain_send']] as const) {
    await claim(db, 'te', age)
    const o = await view(db, 'te')
    assert.deepEqual([o.hold, o.threads[0].hold, o.threads[0].scheduled_at, o.threads[0].next_due_at], [want, want, due, want ? null : due], `age ${age}`)
    // read-only: the claim, the autopilot state and the consent are exactly as before
    assert.deepEqual(await db.get("SELECT status, created_at FROM followup_messages WHERE tenant_id = 'te'"), { status: 'sending', created_at: NOW - age })
    assert.deepEqual(await db.get("SELECT enabled, paused, pause_reason FROM autopilot_settings WHERE tenant_id = 'te'"), { enabled: 1, paused: 0, pause_reason: null })
    assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM consent_ledger WHERE tenant_id = 'te' AND revoked_at IS NULL"))!.n), 1)
    // another tenant's schedule never sees it
    assert.deepEqual((await view(db, 'tf')).threads.map(t => [t.hold, t.next_due_at]), [[null, due]])
    await db.run("DELETE FROM followup_messages WHERE tenant_id = 'te'")
  }
  // a stale claim on the other tenant holds only that tenant
  await claim(db, 'tf', 601)
  assert.deepEqual([(await view(db, 'te')).threads[0].next_due_at, (await view(db, 'tf')).hold], [due, 'uncertain_send'])
  // cleared (the send was resolved as sent): the date is back
  await db.run("UPDATE followup_messages SET status = 'sent' WHERE tenant_id = 'tf'")
  assert.equal((await view(db, 'tf')).threads[0].next_due_at, due)
})

// Every runner-wide stop, audited: the cap holds a thread that is already due (and not a later one); a reply after our
// last follow-up stops the thread at run time.
bothEngines('the daily cap holds a due thread, not a later one; a newer reply holds its thread', async ({ db }) => {
  await ready(db, 'tg', 2)
  await db.run("UPDATE followup_threads SET last_activity_at = ? WHERE tenant_id = 'tg' AND thread_id = 'th-tg-1'", [NOW - 4 * DAY])
  await db.run("UPDATE autopilot_settings SET daily_cap = 2 WHERE tenant_id = 'tg'")
  const dueNow = NOW - 4 * DAY + GAPS_DAYS[0] * DAY
  const by = async () => Object.fromEntries((await view(db, 'tg')).threads.map(t => [t.thread_id, [t.hold, t.next_due_at]]))
  assert.deepEqual(await by(), { 'th-tg-1': [null, dueNow], 'th-tg-2': [null, due] })
  for (const [i, at] of [[1, NOW - 3600], [2, NOW - 7200]]) await db.run("INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES ('tg', ?, 0, 'sent', ?)", [`th-other-${i}`, at])
  assert.deepEqual(await by(), { 'th-tg-1': ['daily_cap', null], 'th-tg-2': [null, due] })
  // a send older than 24 hours no longer counts
  await db.run("UPDATE followup_messages SET created_at = ? WHERE tenant_id = 'tg' AND thread_id = 'th-other-2'", [NOW - DAY - 1])
  assert.deepEqual(await by(), { 'th-tg-1': [null, dueNow], 'th-tg-2': [null, due] })
  // they replied after our last follow-up
  await db.run("UPDATE followup_threads SET followups_sent = 1, last_followup_at = ?, last_lead_reply_at = ? WHERE tenant_id = 'tg' AND thread_id = 'th-tg-2'", [NOW - 2 * DAY, NOW - DAY])
  assert.deepEqual((await by())['th-tg-2'], ['replied_again', null])
})

// The runner itself agrees at the same boundary (stubbed send; nothing leaves the process).
test('runner parity: runFollowups pauses for a 601s sending claim and not for a 600s one', async () => {
  for (const [age, stopped] of [[600, undefined], [601, 'uncertain_send']] as const) {
    const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
    await ready(db, 'tr'); await claim(db, 'tr', age)
    let sends = 0
    const r = await runFollowups(raw, 'tr', 'Biz', { flags: FLAGS, now: NOW, sendFn: async () => { sends++; return { id: 'x' } } })
    assert.deepEqual([r.stopped, sends], [stopped, 0], `age ${age}`)
    assert.equal((await followupOverview(db, 'tr', { flags: FLAGS, now: NOW })).hold, stopped === undefined ? null : 'autopilot_paused')
  }
})
