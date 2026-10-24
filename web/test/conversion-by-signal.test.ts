import { migrateConnectors } from '../lib/connectors/store.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { snapshotSignalContext } from '../lib/outreach/attribution.ts'
import { migrateCalcom } from '../lib/calcom/index.ts'
import { conversionBySignal } from '../lib/outreach/conversion.ts'

// Local synthetic fixture (throwaway :memory: DB). Not live data, not a measurement of any real tenant.
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateReplies(db); migrateCalcom(db)
  return db
}
let n = 0
function lead(db: Database.Database, tenant: string, kind: string | null, source: string | null, stage: string | null = null) {
  const job = createJob(db, tenant, { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const id = `l${++n}`
  db.prepare("INSERT INTO leads (id,scan_job_id,company,signal,source_url,signal_kind,source_kind,stage) VALUES (?,?,?,?,?,?,?,?)").run(id, job, `Co${n}`, 'sig', 'https://x.invalid/p', kind, source, stage)
  return id
}
function msg(db: Database.Database, tenant: string, leadId: string, status: string, snapshot = true) {
  const id = `m${++n}`
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status) VALUES (?,?,?,?,?,?,?)").run(id, tenant, leadId, `${id}@x.invalid`, 'Hello', 'A message long enough to be valid', status)
  if (snapshot) snapshotSignalContext(db, tenant, id, 100)
  return id
}
const reply = (db: Database.Database, tenant: string, m: string, cls: string) =>
  db.prepare("INSERT INTO inbound_messages VALUES (?,?,?,?,?,?,?,?,?)").run(`g${++n}`, tenant, `t${n}`, 'x', 'a@x.invalid', 'short', cls, 200, m)

test('rates per signal kind and source: denominator is sent messages only, zeros are real zeros', () => {
  const db = setup()
  const h1 = msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent')
  const h2 = msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent')
  msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent')
  msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'draft')            // not sent: not in denominator
  msg(db, 'A', lead(db, 'A', 'funding', 'rss'), 'sent')              // sent, no reply: a real zero
  reply(db, 'A', h1, 'positive'); reply(db, 'A', h1, 'other')        // two inbound on one message: counted once
  reply(db, 'A', h2, 'auto')                                         // auto reply is not a reply
  const rows = conversionBySignal(db, 'A')
  const hiring = rows.find(r => r.signal_kind === 'hiring' && r.source_kind === 'query')!
  assert.deepEqual([hiring.sent, hiring.replied, hiring.interested, hiring.booked], [3, 1, 1, 0])
  assert.equal(hiring.reply_rate, 1 / 3)
  const funding = rows.find(r => r.signal_kind === 'funding')!
  assert.deepEqual([funding.sent, funding.replied, funding.interested, funding.booked, funding.reply_rate], [1, 0, 0, 0, 0])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => r.signal_kind), ['hiring', 'funding'] ) // ranked by reply rate, then sent
})

test('opt-out, negative and other count as replies; bounce, soft_bounce and auto do not; negative is not interested', () => {
  const db = setup()
  const ids = ['opt_out', 'negative', 'other', 'bounce', 'soft_bounce', 'auto'].map(c => { const m = msg(db, 'A', lead(db, 'A', 'k', 's'), 'sent'); reply(db, 'A', m, c); return m })
  const r = conversionBySignal(db, 'A')[0]
  assert.deepEqual([r.sent, r.replied, r.interested], [6, 3, 0])
  assert.equal(ids.length, 6)
})

test('booked needs a matched booking recorded at or after the send; earlier bookings, drafts and unlinked bookings do not count', () => {
  const db = setup()
  const book = (leadId: string, uid: string, at: number) => db.prepare("INSERT INTO calcom_bookings (tenant_id,booking_uid,attendee_email,lead_id,created_at) VALUES ('A',?,?,?,?)").run(uid, `${uid}@x.invalid`, leadId, at)
  const sendAt = (m: string, at: number) => db.prepare('UPDATE outreach_messages SET sent_at = ? WHERE id = ?').run(at, m)
  const l1 = lead(db, 'A', 'k', 's'), l2 = lead(db, 'A', 'k', 's'), l3 = lead(db, 'A', 'k', 's'), l4 = lead(db, 'A', 'k', 's')
  const m1 = msg(db, 'A', l1, 'sent'); sendAt(m1, 1000); book(l1, 'u1', 2000); book(l1, 'u1b', 3000) // two bookings, one lead: counted once
  const m2 = msg(db, 'A', l2, 'sent'); sendAt(m2, 1000); book(l2, 'u2', 500)   // booked before the email: not attributed
  const m3 = msg(db, 'A', l3, 'sent')                                         // no sent_at: cannot order, not counted
  book(l3, 'u3', 5000)
  msg(db, 'A', l4, 'draft'); book(l4, 'u4', 5000)                              // draft: not in the denominator
  db.prepare("UPDATE leads SET stage='booked_call' WHERE id IN (?,?,?)").run(l2, l3, l4)  // stage alone never counts
  const r = conversionBySignal(db, 'A')[0]
  assert.deepEqual([r.sent, r.booked], [3, 1])
  void m3
})

test('one signal snapshot per message: later tag changes do not move a message, and a multi-signal lead is counted once', () => {
  const db = setup()
  const l = lead(db, 'A', 'hiring', 'query')
  db.prepare("UPDATE leads SET signals = '[\"hiring\",\"funding\",\"launch\"]' WHERE id = ?").run(l)
  const m = msg(db, 'A', l, 'sent'); reply(db, 'A', m, 'positive')
  db.prepare("UPDATE leads SET signal_kind = 'funding', source_kind = 'rss' WHERE id = ?").run(l) // naive current-tag grouping would now put it under funding
  const rows = conversionBySignal(db, 'A')
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].signal_kind, rows[0].source_kind, rows[0].sent, rows[0].replied], ['hiring', 'query', 1, 1])
})

test('cross-tenant foreign links are never attributed: B reply or booking pointing at A message, and B message pointing at A lead', () => {
  const db = setup()
  const la = lead(db, 'A', 'hiring', 'query')
  const ma = msg(db, 'A', la, 'sent'); db.prepare('UPDATE outreach_messages SET sent_at = 1000 WHERE id = ?').run(ma)
  db.prepare("INSERT INTO inbound_messages VALUES ('gx','B','tx','x','a@x.invalid','short','positive',200,?)").run(ma)           // B-tenant reply row naming A's message
  db.prepare("INSERT INTO calcom_bookings (tenant_id,booking_uid,attendee_email,lead_id,created_at) VALUES ('B','ub','b@x.invalid',?,5000)").run(la) // B booking naming A's lead
  const a = conversionBySignal(db, 'A')
  assert.deepEqual([a[0].sent, a[0].replied, a[0].interested, a[0].booked], [1, 0, 0, 0])
  assert.deepEqual(conversionBySignal(db, 'B'), [])
  // A B-tenant message that names A's lead does not borrow A's booking either
  db.prepare("INSERT INTO calcom_bookings (tenant_id,booking_uid,attendee_email,lead_id,created_at) VALUES ('A','ua','a@x.invalid',?,5000)").run(la)
  const mb = `m${++n}`
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,sent_at) VALUES (?,?,?,?,?,?,'sent',1000)").run(mb, 'B', la, 'b@x.invalid', 'Hello', 'A message long enough to be valid')
  const b = conversionBySignal(db, 'B')
  assert.deepEqual([b[0].sent, b[0].booked, b[0].signal_kind], [1, 0, null])
})

test('sent messages without a stored signal context fall in an explicit unknown bucket, never guessed', () => {
  const db = setup()
  const m = msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent', false)
  reply(db, 'A', m, 'positive')
  const rows = conversionBySignal(db, 'A')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].signal_kind, null); assert.equal(rows[0].source_kind, null)
  assert.deepEqual([rows[0].sent, rows[0].replied, rows[0].interested], [1, 1, 1])
})

test('tenant isolated: B sees none of A, and a tenant with no sends gets an empty list, not invented rows', () => {
  const db = setup()
  const m = msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent'); reply(db, 'A', m, 'positive')
  assert.deepEqual(conversionBySignal(db, 'B'), [])
  msg(db, 'B', lead(db, 'B', 'funding', 'rss'), 'sent')
  const b = conversionBySignal(db, 'B')
  assert.equal(b.length, 1); assert.equal(b[0].signal_kind, 'funding'); assert.equal(b[0].replied, 0)
  assert.equal(conversionBySignal(db, 'A').length, 1)
})

test('test-mode messages are excluded from the denominator', () => {
  const db = setup()
  const m = msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent')
  db.prepare('UPDATE outreach_messages SET test = 1 WHERE id = ?').run(m)
  assert.deepEqual(conversionBySignal(db, 'A'), [])
})

test('the unknown bucket always ranks last, even with a higher rate on fewer sends', () => {
  const db = setup()
  const u = msg(db, 'A', lead(db, 'A', 'hiring', 'query'), 'sent', false); reply(db, 'A', u, 'positive')
  msg(db, 'A', lead(db, 'A', 'funding', 'rss'), 'sent')
  assert.deepEqual(conversionBySignal(db, 'A').map(r => r.signal_kind), ['funding', null])
})
