import test from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateCalcom, getSecret, rotateSecret, verifySignature, parseBooking, recordBooking, listBookings } from '../lib/calcom/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateCalcom(db)
  return db
}
function seedLead(db: Database.Database, contact: string | null, company = 'Acme') {
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES (?, ?, 'Jane', ?, ?, 'hiring', 'https://x.com/1')").run(`lead-${company}`, jobId, company, contact)
  return jobId
}
const sign = (secret: string, raw: string) => crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
const payload = (uid: string, email: string) => JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid, attendees: [{ email, name: 'Jane Doe' }] } })

test('secret: none until rotated, rotate replaces', async () => {
  const db = setup()
  assert.equal(await getSecret(sqliteDb(db), 'u1'), null)
  const s1 = await rotateSecret(sqliteDb(db), 'u1')
  assert.equal(await getSecret(sqliteDb(db), 'u1'), s1)
  const s2 = await rotateSecret(sqliteDb(db), 'u1')
  assert.notEqual(s1, s2)
  assert.equal(await getSecret(sqliteDb(db), 'u1'), s2)
  assert.ok(await getSecret(sqliteDb(db), 'u2') === null || await getSecret(sqliteDb(db), 'u2') !== s2) // tenants isolated
})

test('signature: valid HMAC passes, wrong/malformed fails', async () => {
  const raw = payload('uid1', 'jane@acme.com')
  assert.equal(verifySignature('sec', raw, sign('sec', raw)), true)
  assert.equal(verifySignature('sec', raw, sign('other', raw)), false)
  assert.equal(verifySignature('sec', raw, 'not-hex'), false)
  assert.equal(verifySignature('sec', raw, null), false)
  assert.equal(verifySignature('sec', raw + ' ', sign('sec', raw)), false) // raw body, not normalized
})

test('parseBooking: BOOKING_CREATED only, first attendee, email normalized', async () => {
  assert.deepEqual(parseBooking(payload('u1', '  Jane@ACME.com ')), { uid: 'u1', email: 'jane@acme.com', name: 'Jane Doe' })
  assert.equal(parseBooking(JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', payload: { uid: 'x', attendees: [{ email: 'a@b.c' }] } })), null)
  assert.equal(parseBooking('not json'), null)
  assert.equal(parseBooking(JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { attendees: [] } })), null)
})

test('recordBooking: exact single match stages the lead booked_call', async () => {
  const db = setup()
  seedLead(db, 'jane@acme.com')
  assert.equal(await recordBooking(sqliteDb(db), 'u1', { uid: 'b1', email: 'Jane@Acme.com', name: null }), 'matched')
  const stage = db.prepare("SELECT stage FROM leads WHERE id = 'lead-Acme'").get() as { stage: string }
  assert.equal(stage.stage, 'booked_call')
  const rows = await listBookings(sqliteDb(db), 'u1') as { lead_id: string; company: string }[]
  assert.equal(rows[0].lead_id, 'lead-Acme')
  assert.equal(rows[0].company, 'Acme')
})

test('recordBooking: no match and ambiguous match stay unmatched, never guessed', async () => {
  const db = setup()
  seedLead(db, null) // no contact email at all
  assert.equal(await recordBooking(sqliteDb(db), 'u1', { uid: 'b1', email: 'nobody@example.com', name: null }), 'unmatched')
  seedLead(db, 'shared@acme.com', 'Acme2')
  seedLead(db, 'shared@acme.com', 'Acme3')
  assert.equal(await recordBooking(sqliteDb(db), 'u1', { uid: 'b2', email: 'shared@acme.com', name: null }), 'unmatched') // two leads, never guessed
  const rows = await listBookings(sqliteDb(db), 'u1') as { booking_uid: string; lead_id: string | null }[]
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.lead_id === null))
})

test('recordBooking: idempotent on booking uid (Cal.com retries)', async () => {
  const db = setup()
  seedLead(db, 'jane@acme.com')
  assert.equal(await recordBooking(sqliteDb(db), 'u1', { uid: 'b1', email: 'jane@acme.com', name: null }), 'matched')
  assert.equal(await recordBooking(sqliteDb(db), 'u1', { uid: 'b1', email: 'jane@acme.com', name: null }), 'duplicate')
  assert.equal((await listBookings(sqliteDb(db), 'u1') as unknown[]).length, 1)
})
