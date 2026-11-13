// #367 review at 0d2ff9d4 (F3): a lead's stage follows ALL its bookings, so two concurrent changes to two DIFFERENT
// bookings of one lead must not both read "still standing" before either commits. Two separate Postgres pools (two app
// instances), one lead with two standing bookings, both cancelled at the same moment: afterwards nothing stands and the
// lead's earlier stage is back. Repeated, because a race that loses once proves little; the webhook path and the manual
// reconciliation path are both raced. Without the lead-row lock (lib/calcom lockLeads) each transaction sees the other
// booking standing before and after its own write (READ COMMITTED), neither restores the stage, and the lead stays on
// booked_call. Postgres only (DAZL_TEST_PG_URL, CI's postgres job); test/calcom-outcomes.test.ts checks the statement
// order (lead lock before the first standing read) on every run. Synthetic payloads only; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { parseEvent, recordEvent, setManualOutcome, type CalEvent } from '../lib/calcom/index.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const T = 'tenant_calcom_race_0001'
const ev = (o: object): CalEvent => { const e = parseEvent(JSON.stringify(o)); assert.ok(e); return e }
const booking = (trigger: string, uid: string, email: string, seq: number) => ev({ triggerEvent: trigger, createdAt: `2026-10-0${seq + 1}T09:00:00.000Z`, payload: { uid, iCalSequence: seq, startTime: '2026-10-20T10:00:00Z', endTime: '2026-10-20T10:30:00Z', attendees: [{ email, name: 'Jane' }] } })

test('[pg] two cancellations of two different bookings of one lead, at the same moment on two pools: the lead\'s stage comes back', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const admin = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  const one = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 }), two = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 1 })
  try {
    await runPgMigrations(admin.pool)
    await admin.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('job_calcom_race', ?, 'B', 'I', 'L', 'running')", [T])
    for (let i = 0; i < 30; i++) {
      const lead = `lead_race_${String(i).padStart(2, '0')}`, email = `jane${i}@acme.example`, a = `A${i}`, b = `B${i}`
      await admin.run("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, stage) VALUES (?, 'job_calcom_race', 'Jane', 'Acme', ?, 'hiring', 'https://x.example/1', 'replied')", [lead, email])
      await recordEvent(admin, T, booking('BOOKING_CREATED', a, email, 0))
      await recordEvent(admin, T, booking('BOOKING_CREATED', b, email, 0))
      assert.equal((await admin.get<{ stage: string }>('SELECT stage FROM leads WHERE id = ?', [lead]))!.stage, 'booked_call')
      // even iterations: two webhooks; odd: a webhook against a manual reconciliation
      const cancelA = i % 2 === 0 ? recordEvent(one, T, booking('BOOKING_CANCELLED', a, email, 1)) : setManualOutcome(one, T, 'actor-1', a, 'cancelled')
      const results = await Promise.all([cancelA, recordEvent(two, T, booking('BOOKING_CANCELLED', b, email, 1))])
      const rows = await admin.all<{ booking_uid: string; status: string }>('SELECT booking_uid, status FROM calcom_bookings WHERE tenant_id = ? AND lead_id = ? ORDER BY booking_uid', [T, lead])
      assert.deepEqual(rows, [{ booking_uid: a, status: 'cancelled' }, { booking_uid: b, status: 'cancelled' }], `iteration ${i}: ${JSON.stringify(results)}`)
      assert.equal((await admin.get<{ stage: string }>('SELECT stage FROM leads WHERE id = ?', [lead]))!.stage, 'replied', `iteration ${i}: no booking stands, the earlier stage is back`)
    }
  } finally { await Promise.all([one.close(), two.close(), admin.close()]); await s.drop() }
})
