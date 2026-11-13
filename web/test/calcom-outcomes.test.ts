// #367: Cal.com booking cancellation, reschedule and meeting-held outcomes. Synthetic payloads only (Cal.com's documented
// webhook shapes); no network. Every scenario is delivered in every order, with replays, and must converge.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, type Db, type Tx, type TxOp } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { parseEvent, recordEvent, setManualOutcome, listBookings, type CalEvent } from '../lib/calcom/index.ts'
import { reconcileActions } from '../lib/calcom/outcome-rules.ts'
import { conversionBySignal } from '../lib/outreach/conversion.ts'

const T = 'u1'
function setup(stage: string | null = 'replied') {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const jobId = createJob(db, T, { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, stage) VALUES ('lead-1', ?, 'Jane', 'Acme', 'jane@acme.example', 'hiring', 'https://x.example/1', ?)").run(jobId, stage)
  // one sent message to the lead, before any booking was received (conversion counts bookings received after the send)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('om-1', ?, 'lead-1', 'jane@acme.example', 'Quick question', 'Saw your site and had one idea for it.', 'sent', 100)").run(T)
  return db
}
// A second lead whose stored contact is the meeting's guest (Sam): the attendee a no-show notice may name first.
function setup2() {
  const db = setup()
  const jobId = (db.prepare("SELECT scan_job_id FROM leads WHERE id = 'lead-1'").get() as { scan_job_id: string }).scan_job_id
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, stage) VALUES ('lead-2', ?, 'Sam', 'Acme', 'colleague@acme.example', 'hiring', 'https://x.example/2', 'contacted')").run(jobId)
  return db
}
const stages = (db: Database.Database) => Object.fromEntries((db.prepare("SELECT id, stage FROM leads ORDER BY id").all() as { id: string; stage: string | null }[]).map(r => [r.id, r.stage]))
const ev = (o: object): CalEvent => { const e = parseEvent(JSON.stringify(o)); assert.ok(e, JSON.stringify(o)); return e }
const jane = [{ email: 'Jane@Acme.example', name: 'Jane Doe' }, { email: 'colleague@acme.example', name: 'Sam' }]
const created = ev({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-10-01T09:00:00.000Z', payload: { uid: 'A', iCalUID: 'ical-a', iCalSequence: 0, startTime: '2026-10-10T10:00:00Z', endTime: '2026-10-10T10:30:00Z', attendees: jane } })
const rescheduled = ev({ triggerEvent: 'BOOKING_RESCHEDULED', createdAt: '2026-10-02T09:00:00.000Z', payload: { uid: 'B', rescheduleUid: 'A', iCalUID: 'ical-a', iCalSequence: 1, startTime: '2026-10-12T14:00:00Z', endTime: '2026-10-12T14:30:00Z', attendees: jane } })
const cancelledB = ev({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-10-03T09:00:00.000Z', payload: { uid: 'B', iCalUID: 'ical-a', iCalSequence: 2, startTime: '2026-10-12T14:00:00Z', endTime: '2026-10-12T14:30:00Z', attendees: jane, cancellationReason: 'no longer needed' } })
const endedB = ev({ triggerEvent: 'MEETING_ENDED', uid: 'B', createdAt: '2026-10-01T08:00:00.000Z', startTime: '2026-10-12T14:00:00.000Z', endTime: '2026-10-12T14:30:00.000Z', attendees: jane })

function permutations<X>(xs: X[]): X[][] {
  return xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))
}
// The converged state: every booking row (receipt time and the stage bookkeeping column aside - which standing row
// remembers the earlier stage depends on arrival order, its effect on the lead's stage does not), plus the lead stage.
function state(db: Database.Database) {
  const rows = (db.prepare('SELECT * FROM calcom_bookings ORDER BY booking_uid').all() as Record<string, unknown>[]).map(r => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'created_at' && k !== 'lead_prev_stage')))
  return { rows, stage: (db.prepare("SELECT stage FROM leads WHERE id = 'lead-1'").get() as { stage: string | null }).stage }
}
async function deliver(db: Database.Database, events: CalEvent[], now = 1000) {
  const out = []
  for (const e of events) out.push(await recordEvent(sqliteDb(db), T, e, now))
  return out
}
const conv = (db: Database.Database) => { const r = conversionBySignal(db, T)[0]; return { booked: r.booked, held: r.held, no_show: r.no_show, cancelled: r.cancelled } }

test('parseEvent: the five recorded triggers, Cal.com shapes; anything incomplete is ignored', () => {
  assert.deepEqual(created, { kind: 'booking', trigger: 'BOOKING_CREATED', uid: 'A', at: Date.parse('2026-10-01T09:00:00.000Z'), attendees: [{ email: 'jane@acme.example', name: 'Jane Doe' }, { email: 'colleague@acme.example', name: 'Sam' }], startAt: Date.parse('2026-10-10T10:00:00Z') / 1000, endAt: Date.parse('2026-10-10T10:30:00Z') / 1000, icalUid: 'ical-a', icalSeq: 0, fromUid: null })
  assert.equal(rescheduled.kind === 'booking' && rescheduled.fromUid, 'A')
  assert.deepEqual(endedB, { kind: 'ended', uid: 'B', attendees: created.kind === 'booking' ? created.attendees : [], endAt: Date.parse('2026-10-12T14:30:00Z') / 1000 })
  assert.deepEqual(ev({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: '2026-10-12T15:00:00.000Z', payload: { bookingUid: 'B', attendees: [{ email: 'JANE@acme.example', noShow: true }, { email: 'x@y.example' }] } }),
    { kind: 'no_show', uid: 'B', at: Date.parse('2026-10-12T15:00:00.000Z'), marks: [{ email: 'jane@acme.example', noShow: true }] })
  for (const bad of [
    { triggerEvent: 'BOOKING_RESCHEDULED', payload: { uid: 'B', attendees: jane } }, // does not name the booking it replaces
    { triggerEvent: 'BOOKING_RESCHEDULED', payload: { uid: 'B', rescheduleUid: 'B', attendees: jane } },
    { triggerEvent: 'BOOKING_CANCELLED', payload: { uid: 'B', attendees: [] } },
    { triggerEvent: 'BOOKING_CANCELLED' },
    { triggerEvent: 'MEETING_ENDED', payload: { uid: 'B', attendees: jane } }, // MEETING_ENDED is flat, not wrapped
    { triggerEvent: 'BOOKING_NO_SHOW_UPDATED', payload: { bookingUid: 'B', attendees: [{ email: 'a@b.example' }] } },
    { triggerEvent: 'BOOKING_REQUESTED', payload: { uid: 'B', attendees: jane } },
    { triggerEvent: 'MEETING_STARTED', uid: 'B', attendees: jane },
  ]) assert.equal(parseEvent(JSON.stringify(bad)), null, JSON.stringify(bad))
  assert.equal(parseEvent('not json'), null)
  assert.equal(parseEvent('[]'), null)
})

test('created -> rescheduled -> cancelled converges in all 6 delivery orders, with replays; history kept, nothing counted as booked', async () => {
  const events = [created, rescheduled, cancelledB]
  const finals = []
  for (const order of permutations(events)) {
    const db = setup()
    await deliver(db, [...order, ...order.slice().reverse()]) // every event replayed, in reverse
    finals.push(state(db))
    assert.deepEqual(conv(db), { booked: 0, held: 0, no_show: 0, cancelled: 1 }, `order ${order.map(e => e.kind === 'booking' ? e.trigger : e.kind)}`)
    assert.equal((await listBookings(sqliteDb(db), T)).length, 2, 'both uids stay listed')
  }
  for (const f of finals) assert.deepEqual(f, finals[0])
  const [a, b] = finals[0].rows
  assert.deepEqual([a.booking_uid, a.status, a.rescheduled_to, a.lead_id], ['A', 'rescheduled', 'B', 'lead-1'])
  assert.deepEqual([b.booking_uid, b.status, b.rescheduled_from, b.lead_id, b.ical_seq], ['B', 'cancelled', 'A', 'lead-1', 2])
  assert.equal(b.start_at, Date.parse('2026-10-12T14:00:00Z') / 1000, 'the rescheduled meeting time')
  assert.equal(a.start_at, Date.parse('2026-10-10T10:00:00Z') / 1000, 'the original booking keeps its own time')
  assert.equal(JSON.parse(String(a.attendees)).length, 2, 'every attendee identity is kept')
  assert.equal(finals[0].stage, 'replied', 'the last standing booking went away: the stage the booking replaced comes back')
})

test('created -> rescheduled in either order: one standing booking at the new time, booked once', async () => {
  const finals = []
  for (const order of permutations([created, rescheduled])) {
    const db = setup()
    await deliver(db, order)
    finals.push(state(db))
    assert.deepEqual(conv(db), { booked: 1, held: 0, no_show: 0, cancelled: 0 })
  }
  assert.deepEqual(finals[1], finals[0])
  assert.deepEqual(finals[0].rows.map(r => [r.booking_uid, r.status]), [['A', 'rescheduled'], ['B', 'scheduled']])
  assert.equal(finals[0].stage, 'booked_call')
})

test('a retry or replay is a duplicate; a newer version of the same booking wins whatever the order', async () => {
  const db = setup()
  assert.deepEqual(await recordEvent(sqliteDb(db), T, created, 1000), { outcome: 'matched', status: 'scheduled' })
  assert.deepEqual(await recordEvent(sqliteDb(db), T, created, 2000), { outcome: 'duplicate', status: 'scheduled' })
  const moved = ev({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-09-30T00:00:00.000Z', payload: { uid: 'A', iCalSequence: 3, startTime: '2026-10-20T10:00:00Z', endTime: '2026-10-20T10:30:00Z', attendees: jane } })
  const one = setup(), two = setup()
  await deliver(one, [created, moved]); await deliver(two, [moved, created])
  assert.deepEqual(state(one), state(two))
  assert.equal(state(one).rows[0].start_at, Date.parse('2026-10-20T10:00:00Z') / 1000, 'iCalSequence 3 beats 0 even with an older createdAt')
})

test('MEETING_ENDED is not a held meeting; held comes only from an audited manual reconciliation after the meeting', async () => {
  const db = setup()
  await deliver(db, [created])
  const before = Date.parse('2026-10-10T09:00:00Z') / 1000, after = Date.parse('2026-10-10T11:00:00Z') / 1000
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'A', 'held', {}, before), { ok: false, error: 'not_yet' })
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'A', 'no_show', {}, before), { ok: false, error: 'not_yet' })
  const endedA = ev({ triggerEvent: 'MEETING_ENDED', uid: 'A', endTime: '2026-10-10T10:30:00.000Z', attendees: jane })
  assert.equal((await recordEvent(sqliteDb(db), T, endedA)).status, 'ended')
  assert.deepEqual(conv(db), { booked: 1, held: 0, no_show: 0, cancelled: 0 }, 'ended slot: still booked, not held')
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'A', 'held', { correlationId: 'req-1' }, after), { ok: true, status: 'held' })
  assert.deepEqual(conv(db), { booked: 1, held: 1, no_show: 0, cancelled: 0 })
  const audit = db.prepare("SELECT tenant_id, actor_id, action, resource_type, resource_id, summary, correlation_id FROM audit_events WHERE action = 'booking.outcome_set'").all()
  assert.deepEqual(audit, [{ tenant_id: T, actor_id: 'actor-1', action: 'booking.outcome_set', resource_type: 'calcom_booking', resource_id: 'A', summary: JSON.stringify({ from: 'ended', to: 'held', manual: 'held' }), correlation_id: 'req-1' }])
  // a webhook replay does not undo the person's reconciliation; clearing it brings the webhook-derived status back
  assert.equal((await recordEvent(sqliteDb(db), T, endedA)).status, 'held')
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'A', null, {}, after), { ok: true, status: 'ended' })
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'booking.outcome_set'").get() as { n: number }).n, 2)
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'nope', 'held', {}, after), { ok: false, error: 'not_found' })
})

test('manual reconciliation: a rescheduled-away booking is refused; a manual cancel drops it from booked and restores the stage', async () => {
  const db = setup(null)
  await deliver(db, [created, rescheduled])
  const late = Date.parse('2026-10-13T00:00:00Z') / 1000
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'A', 'held', {}, late), { ok: false, error: 'superseded' })
  assert.equal(state(db).stage, 'booked_call')
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'B', 'cancelled', {}, late), { ok: true, status: 'cancelled' })
  assert.deepEqual(conv(db), { booked: 0, held: 0, no_show: 0, cancelled: 1 })
  assert.equal(state(db).stage, null, 'the lead had no stage before the booking')
})

test('no-show: per attendee, latest mark wins in any order; only the primary attendee decides; ended + no-show converge', async () => {
  const mark = (noShow: boolean, at: string, email = 'jane@acme.example') => ev({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: at, payload: { bookingUid: 'B', attendees: [{ email, noShow }] } })
  const on = mark(true, '2026-10-12T15:00:00.000Z'), off = mark(false, '2026-10-12T16:00:00.000Z'), guest = mark(true, '2026-10-12T15:30:00.000Z', 'colleague@acme.example')
  const finals: unknown[] = []
  for (const order of permutations([rescheduled, endedB, on])) {
    const db = setup(); await deliver(db, order); finals.push(state(db))
    assert.deepEqual(conv(db), { booked: 1, held: 0, no_show: 1, cancelled: 0 })
  }
  for (const f of finals) assert.deepEqual(f, finals[0])
  for (const order of permutations([rescheduled, on, off, guest])) {
    const db = setup(); await deliver(db, order)
    assert.equal(state(db).rows.find(r => r.booking_uid === 'B')!.status, 'scheduled', 'unmarked later; the guest mark does not decide')
  }
})

test('cancel and stage: a stage changed by hand after the booking is left alone; tenants never touch each other', async () => {
  const db = setup()
  await deliver(db, [created])
  db.prepare("UPDATE leads SET stage = 'won' WHERE id = 'lead-1'").run()
  const cancelA = ev({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-10-05T00:00:00.000Z', payload: { uid: 'A', iCalSequence: 1, attendees: jane } })
  await deliver(db, [cancelA])
  assert.equal(state(db).stage, 'won')
  assert.equal((db.prepare('SELECT count(*) AS n FROM calcom_bookings WHERE lead_prev_stage IS NOT NULL').get() as { n: number }).n, 0)
  // the same uid under another tenant is its own booking: unmatched there (no lead of theirs), and A's row is unchanged
  const mine = state(db)
  assert.deepEqual(await recordEvent(sqliteDb(db), 'u2', created), { outcome: 'unmatched', status: 'scheduled' })
  assert.deepEqual(state(db).rows.filter(r => r.tenant_id === T), mine.rows)
  assert.deepEqual(await setManualOutcome(sqliteDb(db), 'u2', 'actor-2', 'A', 'cancelled'), { ok: true, status: 'cancelled' })
  assert.equal((db.prepare("SELECT status FROM calcom_bookings WHERE tenant_id = ? AND booking_uid = 'A'").get(T) as { status: string }).status, 'cancelled')
  assert.equal((db.prepare("SELECT manual_outcome FROM calcom_bookings WHERE tenant_id = ? AND booking_uid = 'A'").get(T) as { manual_outcome: string | null }).manual_outcome, null)
})

// ---- Review at 0d2ff9d4 (Hermes F1-F4 repros, kept as permanent tests) ----

const label = (steps: { name: string }[]) => steps.map(x => x.name).join(' > ')

test('F1: a reschedule supersedes a manual "held" on the old uid, in every delivery order: created, Mark held, rescheduled, cancelled', async () => {
  // Hermes's repro: CREATED A, Mark held after the meeting, then BOOKING_RESCHEDULED A->B, then BOOKING_CANCELLED B.
  // The meeting was moved and then cancelled: nothing stands, nothing was held, the lead's stage comes back.
  const heldAt = Date.parse('2026-10-10T12:00:00Z') / 1000
  let acceptedThenSuperseded = 0
  const steps = [
    { name: 'created', run: (db: Database.Database) => recordEvent(sqliteDb(db), T, created, 1000) },
    { name: 'held', run: (db: Database.Database) => setManualOutcome(sqliteDb(db), T, 'actor-1', 'A', 'held', {}, heldAt) },
    { name: 'rescheduled', run: (db: Database.Database) => recordEvent(sqliteDb(db), T, rescheduled, 1000) },
    { name: 'cancelled', run: (db: Database.Database) => recordEvent(sqliteDb(db), T, cancelledB, 1000) },
  ]
  for (const order of permutations(steps)) {
    const db = setup()
    const out: Record<string, unknown> = {}
    for (const s of order) out[s.name] = await s.run(db)
    const why = label(order)
    assert.deepEqual(conv(db), { booked: 0, held: 0, no_show: 0, cancelled: 1 }, why)
    assert.equal(state(db).stage, 'replied', `${why}: the stage the booking replaced comes back`)
    const a = state(db).rows.find(r => r.booking_uid === 'A')!
    assert.equal(a.status, 'rescheduled', why)
    if ((out.held as { ok: boolean }).ok) {
      acceptedThenSuperseded++
      assert.deepEqual([a.manual_outcome, a.manual_by], ['held', 'actor-1'], `${why}: the manual fields stay as history`)
      assert.equal((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'booking.outcome_set' AND resource_id = 'A'").get() as { n: number }).n, 1, `${why}: and the audit`)
    }
  }
  // the orders where the mark landed before the reschedule notice are the ones the review reproduced
  assert.ok(acceptedThenSuperseded >= 3, `marked before the reschedule in ${acceptedThenSuperseded} orders`)
})

test('F2: the lead link follows the winning attendee: every order of {created, no-show for the guest, rescheduled}, two leads', async () => {
  const guestNoShowA = ev({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: '2026-10-10T11:00:00.000Z', payload: { bookingUid: 'A', attendees: [{ email: 'colleague@acme.example', noShow: true }] } })
  const finals: unknown[] = []
  for (const order of permutations([created, guestNoShowA, rescheduled])) {
    const db = setup2()
    await deliver(db, [...order, ...order.slice().reverse()])
    const why = order.map(e => e.kind === 'booking' ? e.trigger : e.kind).join(' > ')
    const s = state(db)
    assert.deepEqual(s.rows.map(r => [r.booking_uid, r.attendee_email, r.lead_id, r.status]), [['A', 'jane@acme.example', 'lead-1', 'rescheduled'], ['B', 'jane@acme.example', 'lead-1', 'scheduled']], why)
    assert.deepEqual(stages(db), { 'lead-1': 'booked_call', 'lead-2': 'contacted' }, `${why}: the guest's lead is never left booked`)
    assert.equal((db.prepare('SELECT count(*) AS n FROM calcom_bookings WHERE lead_prev_stage IS NOT NULL AND lead_id IS NOT \'lead-1\'').get() as { n: number }).n, 0, `${why}: no stale remembered stage`)
    finals.push({ ...s, stages: stages(db) })
  }
  for (const f of finals) assert.deepEqual(f, finals[0])
  // without the booking event: the reschedule names the meeting's primary attendee, so the guest's early notice does
  // not decide the link in either order
  for (const order of permutations([guestNoShowA, rescheduled])) {
    const db = setup2()
    await deliver(db, order)
    assert.deepEqual(state(db).rows.map(r => [r.booking_uid, r.attendee_email, r.lead_id]), [['A', 'jane@acme.example', 'lead-1'], ['B', 'jane@acme.example', 'lead-1']])
    assert.deepEqual(stages(db), { 'lead-1': 'booked_call', 'lead-2': 'contacted' })
  }
})

test('F2: a booking relinked away from a lead that still has its own booking leaves that lead\'s earlier stage with it (every order)', async () => {
  // A: Jane's meeting, whose guest-first no-show notice briefly links it to Sam's lead. C: Sam's own meeting, later
  // cancelled. Sam's lead must end on its earlier stage whichever booking first remembered it.
  const guestNoShowA = ev({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: '2026-10-10T11:00:00.000Z', payload: { bookingUid: 'A', attendees: [{ email: 'colleague@acme.example', noShow: true }] } })
  const sam = [{ email: 'colleague@acme.example', name: 'Sam' }]
  const createdC = ev({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-10-01T10:00:00.000Z', payload: { uid: 'C', iCalSequence: 0, startTime: '2026-10-11T10:00:00Z', endTime: '2026-10-11T10:30:00Z', attendees: sam } })
  const cancelC = ev({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-10-02T10:00:00.000Z', payload: { uid: 'C', iCalSequence: 1, startTime: '2026-10-11T10:00:00Z', endTime: '2026-10-11T10:30:00Z', attendees: sam } })
  const finals: unknown[] = []
  for (const order of permutations([guestNoShowA, createdC, created, cancelC])) {
    const db = setup2()
    await deliver(db, order)
    const why = order.map(e => (e.kind === 'booking' ? `${e.trigger}:${e.uid}` : `${e.kind}:${e.uid}`)).join(' > ')
    assert.deepEqual(stages(db), { 'lead-1': 'booked_call', 'lead-2': 'contacted' }, why)
    assert.deepEqual(state(db).rows.map(r => [r.booking_uid, r.lead_id, r.status]), [['A', 'lead-1', 'scheduled'], ['C', 'lead-2', 'cancelled']], why)
    finals.push(state(db).rows)
  }
  for (const f of finals) assert.deepEqual(f, finals[0])
})

test('F4: held / no-show need the meeting to be over (end passed or MEETING_ENDED), not just started; fail closed without either', async () => {
  // Hermes's repro: a 10:00-11:00 meeting marked held at 10:01 was accepted
  const hour = ev({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-10-01T09:00:00.000Z', payload: { uid: 'H', iCalSequence: 0, startTime: '2026-10-10T10:00:00Z', endTime: '2026-10-10T11:00:00Z', attendees: jane } })
  const start = Date.parse('2026-10-10T10:00:00Z') / 1000, end = Date.parse('2026-10-10T11:00:00Z') / 1000
  const db = setup()
  await deliver(db, [hour])
  for (const outcome of ['held', 'no_show'] as const) {
    assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'H', outcome, {}, start + 60), { ok: false, error: 'not_yet' }, `${outcome} at start + 1 min`)
    assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'H', outcome, {}, end - 1), { ok: false, error: 'not_yet' }, `${outcome} at end - 1 s`)
  }
  assert.equal(state(db).stage, 'booked_call')
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'H', 'held', {}, end + 1), { ok: true, status: 'held' }, 'end + 1 s')
  assert.deepEqual(await setManualOutcome(sqliteDb(db), T, 'actor-1', 'H', 'no_show', {}, end + 1), { ok: true, status: 'no_show' }, 'end + 1 s')

  // no end time known (a booking notice without times) and no MEETING_ENDED: refused however late; MEETING_ENDED unlocks
  const db2 = setup()
  const bare = ev({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-10-01T09:00:00.000Z', payload: { uid: 'N', attendees: jane } })
  await deliver(db2, [bare])
  assert.deepEqual(await setManualOutcome(sqliteDb(db2), T, 'actor-1', 'N', 'held', {}, end + 86400 * 365), { ok: false, error: 'not_yet' }, 'unknown end: fail closed')
  await deliver(db2, [ev({ triggerEvent: 'MEETING_ENDED', uid: 'N', attendees: jane })])
  assert.deepEqual(await setManualOutcome(sqliteDb(db2), T, 'actor-1', 'N', 'held', {}, end), { ok: true, status: 'held' }, 'MEETING_ENDED is the signal')

  // the panel's controls use the same rule (and only for a member who may configure)
  const row = { status: 'scheduled' as const, end_at: end, ended_at: null, manual_outcome: null }
  assert.deepEqual(reconcileActions(row, true, start + 60), ['cancelled'])
  assert.deepEqual(reconcileActions(row, true, end + 1), ['held', 'no_show', 'cancelled'])
  assert.deepEqual(reconcileActions({ ...row, end_at: null }, true, end + 86400), ['cancelled'], 'unknown end: no held / no-show buttons')
  assert.deepEqual(reconcileActions({ ...row, end_at: null, ended_at: 0, status: 'ended' }, true, start), ['held', 'no_show', 'cancelled'])
  assert.deepEqual(reconcileActions({ ...row, status: 'held', manual_outcome: 'held' }, true, end + 1), ['no_show', 'cancelled', 'clear'])
  assert.deepEqual(reconcileActions({ ...row, status: 'rescheduled' }, true, end + 1), [])
  assert.deepEqual(reconcileActions(row, false, end + 1), [], 'no configure permission: no controls')
  // and the listed booking carries what the panel needs for the rule
  const listed = (await listBookings(sqliteDb(db2), T))[0] as Record<string, unknown>
  assert.ok('end_at' in listed && 'ended_at' in listed)
})

// The Postgres statement order, checked without Postgres: a Db of kind 'pg' that logs every statement a transaction
// body yields and runs it on SQLite with the FOR UPDATE clauses removed (SQLite does not parse them). The two-pool
// race itself runs in test/pg-calcom-lead-lock.test.ts (CI's Postgres job).
function pgShaped(raw: Database.Database): { db: Db; log: string[] } {
  const log: string[] = []
  const t: Tx = {
    kind: 'pg',
    *all<X>(sql: string, params: TxOp['params'] = []) { return (yield { op: 'all', sql, params }) as X[] },
    *get<X>(sql: string, params: TxOp['params'] = []) { return (yield { op: 'get', sql, params }) as X | undefined },
    *run(sql: string, params: TxOp['params'] = []) { return (yield { op: 'run', sql, params }) as { changes: number } },
  }
  const db = {
    kind: 'pg',
    tx: async <X>(body: (t: Tx) => Generator<TxOp, X, unknown>) => raw.transaction(() => {
      const g = body(t)
      let step = g.next()
      while (!step.done) {
        const o = step.value
        log.push(`${o.sql} ${JSON.stringify(o.params)}`)
        const st = raw.prepare(o.sql.replace(/ FOR UPDATE( OF \w+)?/g, ''))
        step = g.next(o.op === 'all' ? st.all(...o.params) : o.op === 'get' ? st.get(...o.params) : { changes: st.run(...o.params).changes })
      }
      return step.value
    }).immediate(),
  } as unknown as Db
  return { db, log }
}
const LEAD_LOCK = /FROM leads l JOIN scan_jobs j .* FOR UPDATE OF l/
const STANDING_READ = /FROM calcom_bookings WHERE tenant_id = \? AND lead_id = \? AND status IN/
const ROW_LOCK = /FROM calcom_bookings WHERE tenant_id = \? AND booking_uid = \? FOR UPDATE/
function assertLockOrder(log: string[], leads: string[], why: string) {
  const at = (re: RegExp) => log.findIndex(l => re.test(l))
  const locks = log.filter(l => LEAD_LOCK.test(l))
  assert.deepEqual(locks.map(l => JSON.parse(l.slice(l.lastIndexOf(' ['))) [0]), leads, `${why}: the affected leads are locked, in id order`)
  assert.ok(at(STANDING_READ) > -1 && at(LEAD_LOCK) < at(STANDING_READ), `${why}: the lead lock comes before the first standing() read`)
  assert.ok(at(LEAD_LOCK) < at(ROW_LOCK), `${why}: leads before booking rows (one lock order everywhere, no deadlock)`)
  assert.ok(log.filter(l => LEAD_LOCK.test(l)).every(l => l.includes('j.user_id = ?') && l.endsWith(`"${T}"]`)), `${why}: tenant-scoped`)
}

test('F3: recordEvent and setManualOutcome lock the affected lead rows (id order, FOR UPDATE on Postgres) before reading standing state', async () => {
  const createdB2 = ev({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-10-01T09:30:00.000Z', payload: { uid: 'B2', iCalSequence: 0, startTime: '2026-10-11T10:00:00Z', endTime: '2026-10-11T10:30:00Z', attendees: jane } })
  const cancelA = ev({ triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-10-05T00:00:00.000Z', payload: { uid: 'A', iCalSequence: 1, attendees: jane } })
  // the race's shape: one lead, two standing bookings, one of them cancelled
  {
    const raw = setup(); await deliver(raw, [created, createdB2])
    const { db, log } = pgShaped(raw)
    await recordEvent(db, T, cancelA)
    assertLockOrder(log, ['lead-1'], 'recordEvent cancel')
    assert.equal(state(raw).stage, 'booked_call', 'B2 still stands')
  }
  {
    const raw = setup(); await deliver(raw, [created, createdB2])
    const { db, log } = pgShaped(raw)
    assert.deepEqual(await setManualOutcome(db, T, 'actor-1', 'B2', 'cancelled', {}, 1000), { ok: true, status: 'cancelled' })
    assertLockOrder(log, ['lead-1'], 'setManualOutcome')
  }
  // a relink touches two leads: both locked, in id order, whichever the booking moves from and to
  {
    const raw = setup2()
    await deliver(raw, [ev({ triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: '2026-10-10T11:00:00.000Z', payload: { bookingUid: 'A', attendees: [{ email: 'colleague@acme.example', noShow: true }] } })])
    const { db, log } = pgShaped(raw)
    await recordEvent(db, T, created)
    assertLockOrder(log, ['lead-1', 'lead-2'], 'recordEvent relink')
    assert.deepEqual(stages(raw), { 'lead-1': 'booked_call', 'lead-2': 'contacted' })
  }
})
