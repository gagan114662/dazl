// #367: Cal.com booking lifecycle on both engines. Created -> rescheduled -> cancelled converges to the same state in
// every delivery order and under replays; a cancelled or superseded booking keeps its history but is not active; a
// meeting counts as held only from a completion signal or a person; tenants never see each other's bookings.
// Synthetic Cal.com payloads only; no network.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import Database from 'better-sqlite3'
import { parseBookingEvent, recordBookingEvent, setMeetingOutcome, bookingCounts, listBookings, migrateCalcom, type BookingEvent } from '../lib/calcom/index.ts'
import { conversionBySignal } from '../lib/outreach/conversion.ts'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'

const T0 = Date.parse('2026-11-02T15:00:00Z') / 1000
const iso = (s: number) => new Date(s * 1000).toISOString()
const body = (trigger: string, payload: Record<string, unknown>, at: number) => JSON.stringify({ triggerEvent: trigger, createdAt: iso(at), payload })
const att = (email: string, extra: Record<string, unknown> = {}) => ({ email, name: 'Pat Example', ...extra })
const created = (uid: string, at: number, start = T0, emails = ['pat@buyer.example']) => body('BOOKING_CREATED', { uid, startTime: iso(start), endTime: iso(start + 1800), attendees: emails.map(e => att(e)) }, at)
const rescheduled = (uid: string, from: string, at: number, start: number) => body('BOOKING_RESCHEDULED', { uid, rescheduleUid: from, startTime: iso(start), endTime: iso(start + 1800), attendees: [att('pat@buyer.example')] }, at)
const cancelled = (uid: string, at: number) => body('BOOKING_CANCELLED', { uid, attendees: [att('pat@buyer.example')] }, at)
const ended = (uid: string, at: number) => body('MEETING_ENDED', { uid }, at)
const noShow = (uid: string, at: number, flag: boolean) => body('BOOKING_NO_SHOW_UPDATED', { bookingUid: uid, attendees: [att('pat@buyer.example', { noShow: flag })] }, at)
const ev = (raw: string) => parseBookingEvent(raw) as BookingEvent

async function seed(db: Db, tenant = 'A', contact = 'pat@buyer.example') {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [`job-${tenant}`, tenant])
  await db.run("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url) VALUES (?, ?, 'Buyer Co', ?, 's', 'https://news.example/a')", [`lead-${tenant}`, `job-${tenant}`, contact])
}
const state = async (db: Db, tenant = 'A') => (await db.all<{ booking_uid: string; status: string; start_at: number | null; lead_id: string | null; outcome: string | null }>(
  'SELECT booking_uid, status, start_at, lead_id, outcome FROM calcom_bookings WHERE tenant_id = ? ORDER BY booking_uid', [tenant])).map(r => ({ ...r, start_at: r.start_at === null ? null : Number(r.start_at) }))
const permutations = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))

test('parseBookingEvent: every tracked trigger, all attendees normalized, reschedule source, ignored otherwise', () => {
  const e = ev(created('u1', T0 - 100, T0, ['Pat@Buyer.example', ' sam@buyer.example ', 'pat@buyer.example']))
  assert.deepEqual([e.kind, e.uid, e.attendees.map(a => a.email), e.startAt, e.endAt, e.eventAt], ['created', 'u1', ['pat@buyer.example', 'sam@buyer.example'], T0, T0 + 1800, T0 - 100])
  assert.deepEqual([ev(rescheduled('u2', 'u1', T0, T0 + 86400)).kind, ev(rescheduled('u2', 'u1', T0, T0 + 86400)).fromUid], ['rescheduled', 'u1'])
  assert.equal(ev(cancelled('u1', T0)).kind, 'cancelled')
  assert.equal(ev(ended('u1', T0)).kind, 'ended')
  assert.deepEqual(ev(noShow('u1', T0, true)).attendees.map(a => a.noShow), [true])
  for (const raw of [body('BOOKING_REQUESTED', { uid: 'u' }, T0), body('BOOKING_CREATED', {}, T0), 'not json', '{}']) assert.equal(parseBookingEvent(raw), null, raw)
})

bothEngines('created -> rescheduled -> cancelled converges in all six delivery orders, with replays', async ({ db }) => {
  const events = [created('old', T0 - 300, T0), rescheduled('new', 'old', T0 - 200, T0 + 86400), cancelled('new', T0 - 100)]
  const want = [
    { booking_uid: 'new', status: 'cancelled', start_at: T0 + 86400, lead_id: 'lead-A', outcome: null },
    { booking_uid: 'old', status: 'rescheduled', start_at: T0, lead_id: 'lead-A', outcome: null },
  ]
  let i = 0
  for (const order of permutations(events)) {
    await db.run('DELETE FROM calcom_bookings'); await db.run('DELETE FROM calcom_booking_events'); await db.run('DELETE FROM leads'); await db.run('DELETE FROM scan_jobs')
    await seed(db)
    for (const raw of [...order, ...order]) await recordBookingEvent(db, 'A', ev(raw)) // every event delivered twice
    assert.deepEqual(await state(db), want, `order ${i++}`)
    assert.deepEqual(await bookingCounts(db, 'A'), { scheduled: 0, held: 0, no_show: 0, cancelled: 1, rescheduled: 1 })
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM calcom_booking_events WHERE tenant_id = ?', ['A']))!.n), 3, 'history: three events, replays not added')
  }
})

bothEngines('reschedule without cancel: the new booking is the active one; an older event never overwrites newer times', async ({ db }) => {
  await seed(db)
  // a second reschedule of the same booking arrives before the first; the first (older) must not move the time back
  assert.equal(await recordBookingEvent(db, 'A', ev(created('b1', T0 - 300, T0))), 'matched')
  await recordBookingEvent(db, 'A', ev(body('BOOKING_CREATED', { uid: 'b2', rescheduleUid: 'b1', startTime: iso(T0 + 7200), endTime: iso(T0 + 9000), attendees: [att('pat@buyer.example')] }, T0 - 100)))
  await recordBookingEvent(db, 'A', ev(rescheduled('b2', 'b1', T0 - 50, T0 + 172800)))
  await recordBookingEvent(db, 'A', ev(rescheduled('b2', 'b1', T0 - 200, T0 + 86400))) // older, delivered last
  assert.deepEqual(await state(db), [
    { booking_uid: 'b1', status: 'rescheduled', start_at: T0, lead_id: 'lead-A', outcome: null },
    { booking_uid: 'b2', status: 'scheduled', start_at: T0 + 172800, lead_id: 'lead-A', outcome: null },
  ])
  assert.deepEqual(await bookingCounts(db, 'A'), { scheduled: 1, held: 0, no_show: 0, cancelled: 0, rescheduled: 1 })
  assert.equal((await db.get<{ stage: string }>("SELECT stage FROM leads WHERE id = 'lead-A'"))!.stage, 'booked_call')
})

bothEngines('cancel before create: the late creation never revives it; a cancelled booking never stages its lead', async ({ db }) => {
  await seed(db)
  await recordBookingEvent(db, 'A', ev(cancelled('c1', T0 - 100)))
  assert.equal(await recordBookingEvent(db, 'A', ev(created('c1', T0 - 300, T0))), 'matched')
  assert.deepEqual(await state(db), [{ booking_uid: 'c1', status: 'cancelled', start_at: T0, lead_id: 'lead-A', outcome: null }])
  assert.notEqual((await db.get<{ stage: string | null }>("SELECT stage FROM leads WHERE id = 'lead-A'"))!.stage, 'booked_call')
  // history stays listed with its state
  assert.deepEqual((await listBookings(db, 'A') as { booking_uid: string; status: string }[]).map(b => [b.booking_uid, b.status]), [['c1', 'cancelled']])
})

bothEngines('held only from a completion signal or a person; no-show from Cal.com; a manual outcome wins and is audited', async ({ db }) => {
  await seed(db)
  await recordBookingEvent(db, 'A', ev(created('m1', T0 - 3000, T0 - 7200)))
  // the meeting time has passed, but nothing said it happened: not held
  assert.deepEqual(await bookingCounts(db, 'A'), { scheduled: 1, held: 0, no_show: 0, cancelled: 0, rescheduled: 0 })
  await recordBookingEvent(db, 'A', ev(ended('m1', T0 - 5400)))
  assert.equal((await bookingCounts(db, 'A')).held, 1)
  await recordBookingEvent(db, 'A', ev(noShow('m1', T0 - 5000, true)))
  assert.deepEqual([(await bookingCounts(db, 'A')).held, (await bookingCounts(db, 'A')).no_show], [0, 1])
  // a person says it was held: wins over later Cal.com signals, and is recorded with who did it
  assert.equal(await setMeetingOutcome(db, 'A', 'm1', 'held', 'user-A', T0), true)
  await recordBookingEvent(db, 'A', ev(noShow('m1', T0 + 10, true)))
  assert.deepEqual(await db.get('SELECT outcome, outcome_source, outcome_by FROM calcom_bookings WHERE booking_uid = ?', ['m1']), { outcome: 'held', outcome_source: 'manual', outcome_by: 'user-A' })
  assert.deepEqual(await db.get("SELECT actor, detail FROM calcom_booking_events WHERE kind = 'manual_outcome'"), { actor: 'user-A', detail: '{"outcome":"held"}' })
  // a cancelled booking has no meeting to mark, and Cal.com's no-show cleared does not erase a manual outcome
  await recordBookingEvent(db, 'A', ev(created('m2', T0 - 3000, T0 - 7200))); await recordBookingEvent(db, 'A', ev(cancelled('m2', T0 - 2000)))
  assert.equal(await setMeetingOutcome(db, 'A', 'm2', 'held', 'user-A', T0), false)
  await recordBookingEvent(db, 'A', ev(ended('m2', T0)))
  assert.equal((await db.get<{ outcome: string | null }>('SELECT outcome FROM calcom_bookings WHERE booking_uid = ?', ['m2']))!.outcome, null)
  assert.equal(await setMeetingOutcome(db, 'B', 'm1', 'no_show', 'user-B', T0), false, 'another tenant cannot mark it')
})

bothEngines('matching across all attendees: exactly one lead links; two leads or none stay unmatched; tenants separate', async ({ db }) => {
  await seed(db, 'A', 'sam@buyer.example'); await seed(db, 'B', 'pat@buyer.example')
  // the second attendee is A's lead: matched (the first attendee alone would have missed it)
  assert.equal(await recordBookingEvent(db, 'A', ev(created('x1', T0, T0, ['pat@buyer.example', 'sam@buyer.example']))), 'matched')
  assert.equal((await state(db, 'A'))[0].lead_id, 'lead-A')
  // B's lead with pat@ is never linked to A's booking, and A's booking is not B's
  assert.deepEqual(await state(db, 'B'), [])
  await db.run("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url) VALUES ('lead-A2', 'job-A', 'Other', 'pat@buyer.example', 's', 'https://news.example/b')")
  assert.equal(await recordBookingEvent(db, 'A', ev(created('x2', T0, T0, ['pat@buyer.example', 'sam@buyer.example']))), 'unmatched', 'two leads: never guessed')
  assert.equal(await recordBookingEvent(db, 'A', ev(created('x3', T0, T0, ['nobody@else.example']))), 'unmatched')
})

test('the booked conversion metric counts only active bookings', async () => {
  const raw = new Database(':memory:')
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts'); migrateAllSqlite(raw); migrateCalcom(raw)
  const { sqliteDb } = await import('../lib/db/client.ts'); const db = sqliteDb(raw)
  await seed(db)
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m', 'A', 'lead-A', 'pat@buyer.example', 's', 'A synthetic outreach body long enough.', 'sent', ?)").run(T0 - 86400)
  await recordBookingEvent(db, 'A', ev(created('k1', T0 - 3600, T0)))
  const booked = () => conversionBySignal(raw, 'A').reduce((n, r) => n + r.booked, 0)
  assert.equal(booked(), 1)
  await recordBookingEvent(db, 'A', ev(cancelled('k1', T0 - 1800)))
  assert.equal(booked(), 0, 'a cancelled booking is not booked')
  await recordBookingEvent(db, 'A', ev(created('k2', T0 - 1700, T0 + 3600)))
  assert.equal(booked(), 1)
})

// The real webhook and Settings routes, in their own process.
test('routes: signed webhook events in any order and replayed, counts in Settings, manual outcome audited and tenant-scoped', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs',
    '--test', './test/helpers/booking-lifecycle-runtime.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
})
