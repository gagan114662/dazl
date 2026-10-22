import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { followupOverview, GAPS_DAYS, MAX_FOLLOWUPS } from '../lib/outreach/followups.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { CONSENT_VERSION, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'

const setup = () => {
  const db = new Database(':memory:')
  migrateAutopilot(db); migrateReplies(db); migrateOutreach(db)
  db.exec("CREATE TABLE leads (id TEXT PRIMARY KEY, company TEXT, name TEXT)")
  db.prepare("INSERT INTO leads VALUES ('l1', 'Acme Robotics', 'Pat Lee')").run()
  db.prepare('INSERT INTO autopilot_settings (tenant_id, enabled, followups_enabled, consent_version) VALUES (?, 1, 1, ?)').run('t1', CONSENT_VERSION)
  return db
}

test('overview: active thread gets a due date from the gap schedule; stopped and exhausted get none', () => {
  const db = setup()
  const now = Math.floor(Date.now() / 1000)
  db.prepare("INSERT INTO followup_threads VALUES ('t1', 'th1', 'l1', 'pat@acmerobotics.com', 'root1', ?, ?, 0, NULL, NULL)").run(now - 86400, now - 86400)
  db.prepare("INSERT INTO followup_threads VALUES ('t1', 'th2', 'l1', 'pat@acmerobotics.com', 'root2', ?, ?, 2, ?, 'replied')").run(now - 10 * 86400, now - 9 * 86400, now - 8 * 86400)
  const o = followupOverview(db, 't1', now)
  assert.equal(o.enabled, true)
  assert.equal(o.threads.length, 2)
  const active = o.threads.find(t => t.thread_id === 'th1')!
  assert.equal(active.company, 'Acme Robotics')
  assert.equal(active.next_due_at, now - 86400 + GAPS_DAYS[0] * 86400)
  const done = o.threads.find(t => t.thread_id === 'th2')!
  assert.equal(done.next_due_at, null)
  assert.equal(done.stopped, 'replied')
  // a thread with no interested reply yet never schedules a follow-up
  db.prepare("INSERT INTO followup_threads VALUES ('t1', 'th3', 'l1', 'pat@acmerobotics.com', 'root3', ?, NULL, 0, NULL, NULL)").run(now)
  assert.equal(followupOverview(db, 't1', now).threads.find(t => t.thread_id === 'th3')!.next_due_at, null)
})

test('overview: sent follow-ups list newest first with company; disabled flag reads settings', () => {
  const db = setup()
  const now = Math.floor(Date.now() / 1000)
  db.prepare("INSERT INTO followup_threads VALUES ('t1', 'th1', 'l1', 'pat@acmerobotics.com', 'root1', ?, ?, 1, ?, NULL)").run(now - 400000, now - 400000, now - 100000)
  db.prepare("INSERT INTO followup_messages VALUES ('t1', 'th1', 0, 'sent', 'g1', ?)").run(now - 100000)
  db.prepare("UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = 't1'").run()
  const o = followupOverview(db, 't1', now)
  assert.equal(o.enabled, false)
  assert.equal(o.sent.length, 1)
  assert.equal(o.sent[0].company, 'Acme Robotics')
  assert.equal(o.sent[0].status, 'sent')
  assert.ok(MAX_FOLLOWUPS === 2 && GAPS_DAYS.length === 2)
})

test('overview: empty account gets empty lists, not an error', () => {
  const db = setup()
  const o = followupOverview(db, 't1')
  assert.deepEqual(o.threads, [])
  assert.deepEqual(o.sent, [])
})

test('overview: a thread held by a runner gate shows the reason and no phantom due date', () => {
  const db = setup()
  migrateSequences(db)
  const now = Math.floor(Date.now() / 1000)
  // consent current here (setup), so this thread is genuinely schedulable
  db.prepare("INSERT INTO followup_threads VALUES ('t1', 'th1', 'l1', 'pat@acmerobotics.com', 'root1', ?, ?, 0, NULL, NULL)").run(now - 86400, now - 86400)
  let o = followupOverview(db, 't1', now)
  assert.equal(o.threads[0].hold_reason, null)
  assert.ok(o.threads[0].next_due_at !== null)
  // sequence enrollment owns the thread: the runner skips it every tick, so no due date
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('s1', 't1', 'l1', 'm1', 'pat@acmerobotics.com', 'active')").run()
  o = followupOverview(db, 't1', now)
  assert.equal(o.threads[0].hold_reason, 'sequence_owned')
  assert.equal(o.threads[0].next_due_at, null)
  db.prepare("DELETE FROM sequences WHERE tenant_id = 't1'").run()
  // stale consent pauses scheduling without hiding the thread
  db.prepare("UPDATE autopilot_settings SET consent_version = '1900-01-01' WHERE tenant_id = 't1'").run()
  o = followupOverview(db, 't1', now)
  assert.equal(o.threads[0].hold_reason, 'consent_stale')
  assert.equal(o.threads[0].next_due_at, null)
  // paused autopilot
  db.prepare("UPDATE autopilot_settings SET consent_version = ?, paused = 1 WHERE tenant_id = 't1'").run(CONSENT_VERSION)
  o = followupOverview(db, 't1', now)
  assert.equal(o.threads[0].hold_reason, 'autopilot_off')
  assert.equal(o.threads[0].next_due_at, null)
  // follow-ups switch off
  db.prepare("UPDATE autopilot_settings SET paused = 0, followups_enabled = 0 WHERE tenant_id = 't1'").run()
  o = followupOverview(db, 't1', now)
  assert.equal(o.threads[0].hold_reason, 'followups_off')
  assert.equal(o.threads[0].next_due_at, null)
  // and a stopped thread keeps its real stop state, never a hold reason
  db.prepare("UPDATE autopilot_settings SET followups_enabled = 1 WHERE tenant_id = 't1'").run()
  db.prepare("UPDATE followup_threads SET stopped = 'replied' WHERE thread_id = 'th1'").run()
  o = followupOverview(db, 't1', now)
  assert.equal(o.threads[0].stopped, 'replied')
  assert.equal(o.threads[0].next_due_at, null)
})
