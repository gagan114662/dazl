// #885 missed-run recovery: a run that comes after skipped runs backfills, from the monitor's source cursors, the events
// dated since each source was last checked, instead of dropping them as outside the play's window. Synthetic leads,
// both engines, no network: each run goes through createMonitor -> runDueMonitors -> the job's leads ->
// collectMonitorResults, like test/monitor-events.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { createMonitor, runDueMonitors, collectMonitorResults } from '../lib/monitors.ts'
import { backfillWindowDays, MAX_BACKFILL_DAYS } from '../lib/monitor-events.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = Math.floor(Date.parse('2026-10-30T12:00:00Z') / 1000), DAY = 86400
const QUERY = 'dental practices that opened a location in the past 14 days' // the play's own 14-day window
const hex = () => randomBytes(12).toString('hex')
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
interface L { company: string; date: string; url?: string }

async function run(db: Db, user: string, mon: string, at: number, leads: L[]) {
  await db.run('UPDATE monitors SET next_run_at = CASE WHEN id = ? THEN ? ELSE 9999999999 END', [mon, at])
  const jobs = await runDueMonitors(db, { now: at })
  assert.equal(jobs.length, 1)
  const job = jobs[0]
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  for (const l of leads) {
    const id = hex(), slug = l.company.toLowerCase().replace(/[^a-z]+/g, '')
    await db.run(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, event_date, date_status, confidence, review_reason, company_domain, signal_kind, quarantined_at, dedup_key)
      VALUES (?, ?, '', ?, 'opened a second location', ?, ?, 'verified', 80, NULL, ?, 'expansion', NULL, ?)`,
      [id, job, l.company, l.url ?? `https://news.example/${slug}`, l.date, `${slug}.example`, id])
    await db.run('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [hex(), id, user, 'scan:actionable', 'actionability', 'Not actionable yet: no published contact', 'https://invalid.example/', day(at), at])
  }
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [at, job])
  await collectMonitorResults(db, { now: at + 3600 })
  const r = (await db.get<{ id: string }>('SELECT id FROM monitor_runs WHERE job_id = ?', [job]))!
  return (await db.all<{ company: string }>('SELECT company FROM monitor_alerts WHERE run_id = ? ORDER BY company', [r.id])).map(a => a.company)
}
async function play(db: Db, user: string) { const r = await createMonitor(db, user, { query: QUERY }, NOW); assert.ok('id' in r); return r.id }

bothEngines('a skipped run is backfilled from cursors: events since the last check alert, older and future ones do not', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{ company: 'Alpha Dental', date: day(NOW - 5 * DAY) }]), ['Alpha Dental'])
  // five weekly runs skipped; the late run's scan returns events from the whole gap
  const late = NOW + 42 * DAY
  const alerts = await run(db, 'u1', mon, late, [
    { company: 'Bravo Dental', date: day(NOW + 6 * DAY) },                                        // in the gap, 36 days before this run: backfilled
    { company: 'Delta Dental', date: day(NOW + 11 * DAY), url: 'https://other.example/delta' },     // a source with no cursor yet: the monitor's last check
    { company: 'Echo Dental', date: day(late - 3 * DAY) },                                         // inside the normal window
    { company: 'Charlie Dental', date: day(NOW - 10 * DAY) },                                     // before the last check: still old news
    { company: 'Future Dental', date: day(late + 20 * DAY) },                                     // future: never
  ])
  assert.deepEqual(alerts, ['Bravo Dental', 'Delta Dental', 'Echo Dental'])
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM monitor_events WHERE user_id = 'u1' AND entity_key IN ('d:charliedental.example', 'd:futuredental.example')"))!.n), 0)
})

bothEngines('an on-time run keeps the play window; a very long gap backfills at most MAX_BACKFILL_DAYS', async ({ db }) => {
  const mon = await play(db, 'u2')
  await run(db, 'u2', mon, NOW, [{ company: 'Alpha Dental', date: day(NOW - 1 * DAY) }])
  // on time (7 days later): an event 20 days old is outside the 14-day window, as before
  assert.deepEqual(await run(db, 'u2', mon, NOW + 7 * DAY, [{ company: 'Old Dental', date: day(NOW - 13 * DAY) }]), [])
  // 200 days later: the backfill stops at MAX_BACKFILL_DAYS
  const late = NOW + 207 * DAY
  assert.deepEqual(await run(db, 'u2', mon, late, [{ company: 'Inside Dental', date: day(late - (MAX_BACKFILL_DAYS - 10) * DAY) }, { company: 'Beyond Dental', date: day(late - (MAX_BACKFILL_DAYS + 10) * DAY) }]), ['Inside Dental'])
})

test('backfillWindowDays', () => {
  assert.equal(backfillWindowDays(14, null, NOW), 14, 'no cursor: the play window')
  assert.equal(backfillWindowDays(14, NOW - 7 * DAY, NOW), 14, 'on time')
  assert.equal(backfillWindowDays(14, NOW - 36 * DAY, NOW), 36, 'late: back to the last check')
  assert.equal(backfillWindowDays(14, NOW - 400 * DAY, NOW), MAX_BACKFILL_DAYS, 'capped')
  assert.equal(backfillWindowDays(180, NOW - 400 * DAY, NOW), 180, 'a longer play window is never shortened')
  assert.equal(backfillWindowDays(14, NOW + DAY, NOW), 14, 'a cursor in the future changes nothing')
})
