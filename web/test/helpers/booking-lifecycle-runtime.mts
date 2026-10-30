// #367: the REAL Cal.com webhook (/api/hooks/calcom) and Settings (/api/settings/calcom) handlers on a fixture store.
// Only the session lookup is replaced (tenant-route-db.ts); synthetic signed payloads; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { rotateSecret } from '../../lib/calcom/index.ts'
import { sqliteDb } from '../../lib/db/client.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-cal-')), 'app.db')
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hook = await import('../../app/api/hooks/calcom/route.ts')
const settings = await import('../../app/api/settings/calcom/route.ts')
const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
for (const t of ['tenantA', 'tenantB']) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')").run(`job-${t}`, t)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url) VALUES (?, ?, 'Buyer Co', 'pat@buyer.example', 's', 'https://news.example/a')").run(`lead-${t}`, `job-${t}`)
}
const secrets = { tenantA: await rotateSecret(sqliteDb(db), 'tenantA'), tenantB: await rotateSecret(sqliteDb(db), 'tenantB') }
const T0 = Date.parse('2026-11-02T15:00:00Z') / 1000
const iso = (s: number) => new Date(s * 1000).toISOString()
const body = (trigger: string, payload: Record<string, unknown>, at: number) => JSON.stringify({ triggerEvent: trigger, createdAt: iso(at), payload })
const send = async (tenant: 'tenantA' | 'tenantB', raw: string, secret = secrets[tenant]) => {
  const sig = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  db.prepare('DELETE FROM rate_limits').run()
  const r = (await hook.POST(new NextRequest(`http://localhost/api/hooks/calcom?u=${tenant}`, { method: 'POST', headers: { 'x-cal-signature-256': sig, 'content-type': 'application/json' }, body: raw })))!
  return { status: r.status, json: await r.json() as Record<string, unknown> }
}
const asUser = (id: string) => setUser({ id, business_name: id })
const get = async () => (await (await settings.GET(new NextRequest('http://localhost/api/settings/calcom', { headers: { host: 'localhost' } })))!.json()) as { counts: Record<string, number>; bookings: { booking_uid: string; status: string; outcome: string | null }[] }
const mark = async (booking_uid: string, outcome: string | null) => { db.prepare('DELETE FROM rate_limits').run(); return (await settings.POST(new NextRequest('http://localhost/api/settings/calcom', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: JSON.stringify({ action: 'outcome', booking_uid, outcome }) })))!.status }

test('webhook events in reverse order and replayed converge; Settings shows counts; manual outcome audited; tenant-scoped', async () => {
  const att = [{ email: 'pat@buyer.example', name: 'Pat' }]
  const events = [
    body('BOOKING_CREATED', { uid: 'old', startTime: iso(T0), endTime: iso(T0 + 1800), attendees: att }, T0 - 300),
    body('BOOKING_RESCHEDULED', { uid: 'new', rescheduleUid: 'old', startTime: iso(T0 - 7200), endTime: iso(T0 - 5400), attendees: att }, T0 - 200),
    body('MEETING_ENDED', { uid: 'new' }, T0 - 5400),
  ]
  for (const raw of [...events].reverse()) assert.equal((await send('tenantA', raw)).status, 200)
  assert.equal((await send('tenantA', events[1])).json.outcome, 'duplicate', 'a replay is a duplicate')
  assert.equal((await send('tenantA', events[0], 'wrong-secret')).status, 401, 'unsigned events change nothing')
  asUser('tenantA')
  let s = await get()
  assert.deepEqual(s.counts, { scheduled: 1, held: 1, no_show: 0, cancelled: 0, rescheduled: 1 })
  assert.deepEqual(s.bookings.map(b => [b.booking_uid, b.status, b.outcome]).sort(), [['new', 'scheduled', 'held'], ['old', 'rescheduled', null]])
  // a person corrects it to a no-show: recorded with who did it
  assert.equal(await mark('new', 'no_show'), 200)
  s = await get()
  assert.deepEqual([s.counts.held, s.counts.no_show], [0, 1])
  assert.deepEqual(db.prepare("SELECT actor, detail FROM calcom_booking_events WHERE kind = 'manual_outcome'").all(), [{ actor: 'tenantA', detail: '{"outcome":"no_show"}' }])
  assert.equal(await mark('old', 'held'), 409, 'a superseded booking has no meeting to mark')
  assert.equal(await mark('new', 'maybe'), 400)
  // tenant B sees nothing of A's and cannot mark A's booking
  asUser('tenantB')
  assert.deepEqual((await get()).bookings, [])
  assert.equal(await mark('new', 'held'), 409)
  assert.equal((db.prepare("SELECT outcome FROM calcom_bookings WHERE tenant_id = 'tenantA' AND booking_uid = 'new'").get() as { outcome: string }).outcome, 'no_show')
  // the same uid sent by tenant B is B's own booking
  assert.equal((await send('tenantB', events[0])).json.outcome, 'matched')
  assert.deepEqual((await get()).bookings.map(b => b.booking_uid), ['old'])
})
