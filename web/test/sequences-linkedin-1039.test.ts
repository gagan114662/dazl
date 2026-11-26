// #1039: manual LinkedIn steps in a sequence. A LinkedIn task never sends anything and dazl never contacts LinkedIn:
// creating a sequence drafts a connect task and a message task next to the three email steps; approval starts their
// clock (connect due at once, message due at the step-2 gap); the user copies the words, opens the profile in their
// own browser, and marks the task done or skipped. Done is recorded as a touch; the email steps are untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, approve } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, dueLinkedinTasks, markLinkedinTask, removeLinkedinTask, linkedinTouches, linkedinTasksForSequence } from '../lib/outreach/sequences.ts'
import { sqliteDb } from '../lib/db/client.ts'

const NOW = 1800000000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y' })) as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A')
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence) VALUES (?,?,?,?,?,?,?,?,?)').run(lead, job, 'Acme', 'Dana Lee', 'dana@acme.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(lead)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'search:people', 'person', 'Dana Lee, VP Operations', NULL, 'https://www.linkedin.com/in/danalee', '2026-11-20', ?)").run(randomBytes(12).toString('hex'), lead, NOW)
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES (?,'A',?,?,'A quick question','This is a draft message for review.')").run(mid, lead, 'dana@acme.example')
  const seq = createSequence(db, 'A', mid)
  return { db, lead, mid, seq }
}

test('#1039 creating a sequence drafts a LinkedIn connect task and a LinkedIn message task beside the email steps', async () => {
  const { db, seq } = await setup()
  const tasks = await linkedinTasksForSequence(sqliteDb(db), 'A', seq)
  assert.deepEqual(tasks.map(t => t.kind), ['connect', 'message'])
  for (const t of tasks) {
    assert.equal(t.profile_url, 'https://www.linkedin.com/in/danalee')
    assert.match(t.body, /Hiring roofers/, 'drafted from the same lead evidence as the email')
    assert.equal(t.status, 'pending')
    assert.equal(t.due_at, null, 'nothing is due before the set is approved')
  }
  assert.ok(tasks[0].body.length <= 300, 'a connection note fits the LinkedIn note limit')
  assert.deepEqual(await dueLinkedinTasks(sqliteDb(db), 'A', NOW), [], 'no task is due before approval')
})

test('#1039 approval starts the clock: connect due at once, message due at the step-2 gap; done records a touch and leaves the emails alone', async () => {
  const { db, seq } = await setup()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  const dueNow = await dueLinkedinTasks(sqliteDb(db), 'A', NOW)
  assert.deepEqual(dueNow.map(t => t.kind), ['connect'])
  assert.deepEqual((await dueLinkedinTasks(sqliteDb(db), 'A', NOW + 3 * DAY)).map(t => t.kind), ['connect', 'message'])
  const stepsBefore = db.prepare('SELECT step, status FROM sequence_steps WHERE tenant_id = ? AND sequence_id = ? ORDER BY step').all('A', seq)
  await markLinkedinTask(sqliteDb(db), db, 'A', dueNow[0].id, 'done', NOW + 60)
  assert.equal(await linkedinTouches(sqliteDb(db), 'A'), 1)
  assert.deepEqual((await dueLinkedinTasks(sqliteDb(db), 'A', NOW + 3 * DAY)).map(t => t.kind), ['message'], 'the done task leaves the Today list')
  assert.deepEqual(db.prepare('SELECT step, status FROM sequence_steps WHERE tenant_id = ? AND sequence_id = ? ORDER BY step').all('A', seq), stepsBefore, 'email steps untouched')
  const audit = db.prepare("SELECT action, detail, lead_id FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'linkedin_touch'").get() as { action: string; detail: string; lead_id: string } | undefined
  assert.ok(audit, 'the touch is on the lead timeline record')
  // another tenant cannot mark it, and a done task cannot be marked again
  const msg = (await dueLinkedinTasks(sqliteDb(db), 'A', NOW + 3 * DAY))[0]
  await assert.rejects(() => markLinkedinTask(sqliteDb(db), db, 'B', msg.id, 'done', NOW), /not_found/)
  await markLinkedinTask(sqliteDb(db), db, 'A', msg.id, 'skipped', NOW + 3 * DAY)
  assert.equal(await linkedinTouches(sqliteDb(db), 'A'), 1, 'a skip is not a touch')
  assert.deepEqual(await dueLinkedinTasks(sqliteDb(db), 'A', NOW + 3 * DAY), [])
})

test('#1039 a pending task can be removed in the editor; a sequence for a lead with no LinkedIn profile still drafts the tasks with no link', async () => {
  const { db, seq, lead } = await setup()
  const [connect] = await linkedinTasksForSequence(sqliteDb(db), 'A', seq)
  await removeLinkedinTask(sqliteDb(db), 'A', connect.id)
  assert.deepEqual((await linkedinTasksForSequence(sqliteDb(db), 'A', seq)).map(t => t.kind), ['message'])
  db.prepare("UPDATE lead_enrichments SET source_url = 'https://acme.example/team' WHERE lead_id = ?").run(lead)
  const job2 = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job2)
  const lead2 = randomBytes(12).toString('hex'), mid2 = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence) VALUES (?,?,?,?,?,?,?,?,?)').run(lead2, job2, 'Beta', 'Sam Ray', 'sam@beta.example', 'Opening a depot', 'https://beta.example/news', 'Opening a depot', 90)
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES (?,'A',?,?,'Hi','This is a draft message for review.')").run(mid2, lead2, 'sam@beta.example')
  const seq2 = createSequence(db, 'A', mid2)
  const tasks2 = await linkedinTasksForSequence(sqliteDb(db), 'A', seq2)
  assert.equal(tasks2.length, 2)
  assert.equal(tasks2[0].profile_url, null, 'no profile known, no link invented')
})
