import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audienceOf, savedPlays, scheduleOf, type MonitorRow, type WatchRow } from '../lib/saved-plays.ts'

// Synthetic rows in the shapes GET /api/watch and GET /api/monitors return.
const T = Date.UTC(2026, 9, 26, 12) / 1000
const ICP = { summary: 'Independent dental practices', where: ['Leeds, UK'], signals: ['opening a second location', 'hiring a practice manager'] }
const watch = (o: Partial<WatchRow> = {}): WatchRow => ({ id: 'a'.repeat(24), query: 'Dental practices in Leeds opening a second location', icp: ICP, active: true, next_run_at: T + 7 * 86400, last_run_at: T, paused_reason: null, last_job_id: 'b'.repeat(24), last_status: 'done', new_leads: 3, ...o })
const monitor = (o: Partial<MonitorRow> = {}): MonitorRow => ({ id: 'c'.repeat(24), query: 'Accounting firms hiring payroll staff', icp: JSON.stringify({ summary: 'Accounting firms', signals: ['hiring'] }), interval_hours: 24, enabled: 1, paused_reason: null, last_run_at: null, next_run_at: T + 86400, last_new_count: null, run_count: 0, last_job_id: null, ...o })
const UTC = 'UTC'

test('a weekly watch shows who, signal, schedule, last and next run, status and a link to its last results', () => {
  const [p] = savedPlays([watch()], [], UTC)
  assert.deepEqual({ ...p, name: undefined }, {
    id: 'a'.repeat(24), kind: 'watch', name: undefined, sentence: 'Dental practices in Leeds opening a second location',
    audience: 'Independent dental practices · Leeds, UK', signal: 'opening a second location, hiring a practice manager', schedule: 'Weekly',
    lastRun: '26 Oct 2026, 3 new', lastHref: `/app/leads?job_id=${'b'.repeat(24)}`, nextRun: '2 Nov 2026',
    status: { tone: 'live', label: 'Live' }, active: true,
  })
  assert.ok(p.name.length > 0 && p.name.length <= 60)
})

test('status: paused (with why), running now, last run failed; a paused play has no next run', () => {
  const s = (o: Partial<WatchRow>) => savedPlays([watch(o)], [], UTC)[0]
  assert.deepEqual([s({ active: false }).status, s({ active: false }).nextRun], [{ tone: 'paused', label: 'Paused' }, 'Paused: resume to schedule it'])
  assert.equal(s({ active: false, paused_reason: 'quota' }).status.label, "Paused: this month's scans are used up")
  assert.equal(s({ active: false, paused_reason: 'no_key' }).status.label, 'Paused: no AI key to run it')
  assert.deepEqual(s({ last_status: 'running' }).status, { tone: 'running', label: 'Running now' })
  assert.deepEqual(s({ last_status: 'failed' }).status, { tone: 'failed', label: 'Live, last run failed' })
  assert.equal(s({ last_status: 'failed' }).lastRun, '26 Oct 2026', 'a failed run claims no new leads')
  assert.deepEqual([s({ last_run_at: null, last_job_id: null }).lastRun, s({ last_run_at: null, last_job_id: null }).lastHref], ['Not run yet', null])
})

test('scheduled monitors join the list with their own cadence and pause state', () => {
  const [m] = savedPlays(null, [monitor()], UTC)
  assert.deepEqual([m.kind, m.audience, m.signal, m.schedule, m.lastRun, m.nextRun, m.status.label, m.active], ['monitor', 'Accounting firms', 'hiring', 'Daily', 'Not run yet', '27 Oct 2026', 'Live', true])
  const off = savedPlays(null, [monitor({ enabled: 0, paused_reason: 'quota', last_run_at: T, last_new_count: 2, last_job_id: 'd'.repeat(24) })], UTC)[0]
  assert.deepEqual([off.status.label, off.nextRun, off.lastRun, off.lastHref], ["Paused: this month's scans are used up", 'Paused: resume to schedule it', '26 Oct 2026, 2 new', `/app/leads?job_id=${'d'.repeat(24)}`])
  assert.deepEqual([168, 336, 24, 72, 12].map(scheduleOf), ['Weekly', 'Every 2 weeks', 'Daily', 'Every 3 days', 'Every 12 hours'])
})

test('no saved profile, a bad profile or no lists: nothing invented', () => {
  assert.equal(audienceOf(null), null)
  const [p] = savedPlays([watch({ icp: null })], null, UTC)
  assert.deepEqual([p.audience, p.signal], [null, null])
  assert.equal(savedPlays(null, [monitor({ icp: '{not json' })], UTC)[0].audience, null)
  assert.deepEqual(savedPlays(null, null), [])
})
