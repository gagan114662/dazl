// #367 regression through the real Cal.com webhook route (signed deliveries, same path Cal.com uses): a booking that is
// rescheduled and then cancelled must stop counting as booked, the lead's stage must come back, and the history must
// stay. Before #367 the route recorded only BOOKING_CREATED and dropped the reschedule/cancel notices, so the cancelled
// meeting kept counting as "Booked" and the lead stayed on 'booked_call'. Synthetic payloads only; no network.
// Run by test/calcom-lifecycle-route.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const { setDb, sqliteDb } = await import('../../lib/db/client.ts')
const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
const { rotateSecret } = await import('../../lib/calcom/index.ts')
const { createJob } = await import('../../lib/scan/store.ts')
const { conversionBySignal } = await import('../../lib/outreach/conversion.ts')
const calcom = await import('../../app/api/hooks/calcom/route.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
const db = sqliteDb(raw)
setDb(db)
const T = 'tenant_367_route'
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex')

test('created -> rescheduled -> cancelled through the signed route: not booked any more, stage restored, history kept', async () => {
  const secret = await rotateSecret(db, T)
  const jobId = createJob(raw, T, { business_name: 'B', industry: 'I', location: 'L' })
  raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  raw.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, stage) VALUES ('lead-r', ?, 'Jane', 'Acme', 'jane@acme.example', 'hiring', 'https://x.example/1', 'replied')").run(jobId)
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('om-r', ?, 'lead-r', 'jane@acme.example', 'Quick question', 'Saw your site and had one idea for it.', 'sent', 100)").run(T)
  const post = async (o: object) => {
    const body = JSON.stringify(o)
    const res = await calcom.POST(new NextRequest(`https://dazl.test/api/hooks/calcom?u=${T}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-cal-signature-256': hmac(secret, body) } }))
    assert.equal(res.status, 200, body)
  }
  const stage = () => (raw.prepare("SELECT stage FROM leads WHERE id = 'lead-r'").get() as { stage: string | null }).stage
  const booked = () => conversionBySignal(raw, T).reduce((s, r) => s + r.booked, 0)
  const attendees = [{ email: 'Jane@Acme.example', name: 'Jane Doe' }]

  await post({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-10-01T09:00:00.000Z', payload: { uid: 'R-A', iCalUID: 'ical-r', iCalSequence: 0, startTime: '2026-10-10T10:00:00Z', endTime: '2026-10-10T10:30:00Z', attendees } })
  assert.equal(booked(), 1, 'a new booking counts')
  assert.equal(stage(), 'booked_call')

  await post({ triggerEvent: 'BOOKING_RESCHEDULED', createdAt: '2026-10-02T09:00:00.000Z', payload: { uid: 'R-B', rescheduleUid: 'R-A', iCalUID: 'ical-r', iCalSequence: 1, startTime: '2026-10-12T14:00:00Z', endTime: '2026-10-12T14:30:00Z', attendees } })
  assert.equal(booked(), 1, 'a rescheduled booking still counts once, not twice')
  assert.equal(stage(), 'booked_call')

  await post({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-10-03T09:00:00.000Z', payload: { uid: 'R-B', iCalUID: 'ical-r', iCalSequence: 2, startTime: '2026-10-12T14:00:00Z', endTime: '2026-10-12T14:30:00Z', attendees, cancellationReason: 'no longer needed' } })
  assert.equal(booked(), 0, 'a cancelled meeting leaves the active booking count')
  assert.equal(stage(), 'replied', 'the lead goes back to the stage it had before the booking')
  const n = (raw.prepare('SELECT COUNT(*) AS n FROM calcom_bookings WHERE tenant_id = ?').get(T) as { n: number }).n
  assert.equal(n, 2, 'history is kept: both booking uids stay recorded')
})
