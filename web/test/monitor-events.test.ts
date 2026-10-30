// #387: event-level monitor detection. Synthetic leads; both engines for the store. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { createMonitor } from '../lib/monitors.ts'
import { foldRunEvents, decide, detectionLatency, missedRuns, eventKeyOf, entityKeyOf, DEFAULT_POLICY, type RunLead, type AlertPolicy } from '../lib/monitor-events.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = Math.floor(Date.parse('2026-10-30T12:00:00Z') / 1000), DAY = 86400
const lead = (o: Partial<RunLead> = {}): RunLead => ({ company: 'Harbor Dental', company_domain: 'harbordental.example', contact: null, source_url: 'https://news.example/harbor-opens', event_date: '2026-10-20', signal: 'opened a second location', review_reason: null, confidence: 80, quarantined_at: null, date_status: 'verified', ...o })

async function setup(db: Db, user = 'u1') {
  const m = await createMonitor(db, user, { query: 'dental practices opening' }) as { id: string }
  return m.id
}
const fold = (db: Db, user: string, mon: string, leads: RunLead[], now: number, policy?: AlertPolicy) => db.tx(function* (t) { return yield* foldRunEvents(t, { userId: user, monitorId: mon, runId: `run${now}`, leads, now, policy }) })

bothEngines('same company with a genuinely new event is surfaced once; repeated old news is suppressed', async ({ db }) => {
  const mon = await setup(db)
  let r = await fold(db, 'u1', mon, [lead()], NOW)
  assert.deepEqual(r.alerts.map(a => a.kind), ['new_company'])
  r = await fold(db, 'u1', mon, [lead()], NOW + 7 * DAY)
  assert.equal(r.alerts.length, 0); assert.equal(r.suppressed.unchanged, 1)
  r = await fold(db, 'u1', mon, [lead({ source_url: 'https://news.example/harbor-hires', event_date: '2026-11-02', signal: 'hiring a sales director' })], NOW + 14 * DAY)
  assert.deepEqual(r.alerts.map(a => a.kind), ['new_signal'])
  r = await fold(db, 'u1', mon, [lead({ source_url: 'https://news.example/harbor-hires', event_date: '2026-11-02' })], NOW + 21 * DAY)
  assert.equal(r.alerts.length, 0)
})

bothEngines('a blocked / needs-review research item does not inflate alerts; it alerts once it becomes actionable', async ({ db }) => {
  const mon = await setup(db)
  const blocked = lead({ review_reason: 'page blocked: could not read the cited page', confidence: null })
  let r = await fold(db, 'u1', mon, [blocked, lead({ company: 'Q Dental', company_domain: 'q.example', quarantined_at: 5 })], NOW)
  assert.equal(r.alerts.length, 0); assert.equal(r.suppressed.not_actionable, 2)
  r = await fold(db, 'u1', mon, [lead()], NOW + DAY)   // same event, now verified
  assert.deepEqual(r.alerts.map(a => a.kind), ['newly_actionable'])
})

bothEngines('a newly verified contact triggers a state-change alert, once', async ({ db }) => {
  const mon = await setup(db)
  await fold(db, 'u1', mon, [lead()], NOW)
  let r = await fold(db, 'u1', mon, [lead({ contact: 'office@harbordental.example' })], NOW + DAY)
  assert.deepEqual(r.alerts.map(a => a.kind), ['now_reachable'])
  r = await fold(db, 'u1', mon, [lead({ contact: 'office@harbordental.example' })], NOW + 2 * DAY)
  assert.equal(r.alerts.length, 0)
})

bothEngines('old news on first sight is recorded but not alerted; undated events dedupe by signal text', async ({ db }) => {
  const mon = await setup(db)
  let r = await fold(db, 'u1', mon, [lead({ event_date: '2025-01-05' })], NOW)
  assert.equal(r.alerts.length, 0); assert.equal(r.suppressed.old_news, 1)
  r = await fold(db, 'u1', mon, [lead({ company: 'Cedar Vet', company_domain: 'cedar.example', event_date: null, source_url: 'https://a.example/1', signal: 'Cedar Vet is expanding' })], NOW)
  assert.equal(r.alerts.length, 1)
  r = await fold(db, 'u1', mon, [lead({ company: 'Cedar Vet', company_domain: 'cedar.example', event_date: null, source_url: 'https://b.example/other-url', signal: 'Cedar  Vet is expanding!' })], NOW + DAY)
  assert.equal(r.alerts.length, 0, 'same undated signal under another URL is not new')
})

bothEngines('deduped across plays and isolated across tenants', async ({ db }) => {
  const m1 = await setup(db), m2 = await createMonitor(db, 'u1', { query: 'another play', intervalHours: 168 }) as { id: string }
  assert.equal((await fold(db, 'u1', m1, [lead()], NOW)).alerts.length, 1)
  assert.equal((await fold(db, 'u1', m2.id, [lead()], NOW + DAY)).alerts.length, 0, 'the other play does not alert the same event again')
  const other = await setup(db, 'u2')
  assert.equal((await fold(db, 'u2', other, [lead()], NOW + DAY)).alerts.length, 1, 'another tenant has its own state')
})

bothEngines('alert policy: only the selected kinds alert; cursors advance per source; latency is reported', async ({ db }) => {
  const mon = await setup(db)
  const onlyNew: AlertPolicy = { ...DEFAULT_POLICY, kinds: new Set(['new_company']) }
  await fold(db, 'u1', mon, [lead()], NOW, onlyNew)
  const r = await fold(db, 'u1', mon, [lead({ contact: 'office@harbordental.example' })], NOW + DAY, onlyNew)
  assert.equal(r.alerts.length, 0); assert.equal(r.suppressed.policy, 1)
  const cur = await db.get<{ last_event_at: number }>("SELECT last_event_at FROM monitor_cursors WHERE monitor_id = ? AND source = 'news.example'", [mon])
  assert.equal(Number(cur!.last_event_at), Math.floor(Date.parse('2026-10-20T00:00:00Z') / 1000))
  const lat = await detectionLatency(db, 'u1', 0)
  assert.equal(lat.alerts, 1); assert.equal(lat.medianS, NOW - Math.floor(Date.parse('2026-10-20T00:00:00Z') / 1000))
})

test('decide is pure: keys are spelling-independent; unverified-date leads are not actionable', () => {
  assert.equal(entityKeyOf(lead({ company: 'HARBOR Dental, Inc', company_domain: null })), entityKeyOf(lead({ company: 'harbor dental', company_domain: null })))
  assert.equal(eventKeyOf(lead()), eventKeyOf(lead({ source_url: 'https://www.news.example/harbor-opens/?utm=1' })))
  assert.deepEqual(decide(lead({ date_status: 'unverified' }), { entityKnown: false, event: null }, NOW), { suppress: 'not_actionable' })
})

test('missed-run recovery: skipped runs are counted and the next lookback covers the gap', () => {
  assert.deepEqual(missedRuns({ last_run_at: NOW - 3 * 7 * DAY, interval_hours: 168 }, NOW).missed, 2)
  const normal = missedRuns({ last_run_at: NOW - 7 * DAY, interval_hours: 168 }, NOW); assert.equal(normal.missed, 0)
  const gap = missedRuns({ last_run_at: NOW - 30 * DAY, interval_hours: 168 }, NOW); assert.ok(gap.lookbackDays >= 30 + 7)
  assert.equal(missedRuns({ last_run_at: null, interval_hours: 24 }, NOW).missed, 0)
})
