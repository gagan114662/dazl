// #387: continuous event detection on the monitor scheduler. Synthetic leads only, both engines, no network: each run
// goes through the real path (createMonitor -> runDueMonitors -> the job's leads -> collectMonitorResults).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { createMonitor, runDueMonitors, collectMonitorResults, listMonitors, monitorWindowDays } from '../lib/monitors.ts'
import { decide, detectionReport, entityKeyOf, eventKeyOf, missedRuns, uncoveredDays, DEFAULT_EVENT_WINDOW_DAYS, type AlertPolicy, type RunLead } from '../lib/monitor-events.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = Math.floor(Date.parse('2026-10-30T12:00:00Z') / 1000), DAY = 86400
const hex = () => randomBytes(12).toString('hex')
interface L { company?: string; domain?: string | null; date?: string | null; dateStatus?: string; kind?: string | null; url?: string; review?: string | null; conf?: number | null; quarantined?: boolean; reachable?: boolean; held?: boolean }

async function play(db: Db, user: string, o: { query?: string; policy?: AlertPolicy } = {}): Promise<string> {
  const r = await createMonitor(db, user, { query: o.query ?? 'dental practices opening a new location', alertPolicy: o.policy }, NOW)
  assert.ok('id' in r)
  return r.id
}

// One scheduled run of `mon` at `at` that returns `leads`; returns the run's new_count and the alerts it wrote.
async function run(db: Db, user: string, mon: string, at: number, leads: L[]) {
  await db.run('UPDATE monitors SET next_run_at = CASE WHEN id = ? THEN ? ELSE 9999999999 END', [mon, at])
  const jobs = await runDueMonitors(db, { now: at })
  assert.equal(jobs.length, 1)
  const job = jobs[0]
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  for (const l of leads) {
    const id = hex()
    await db.run(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, event_date, date_status, confidence, review_reason, company_domain, signal_kind, quarantined_at, dedup_key)
      VALUES (?, ?, '', ?, 'opened a second location', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, job, l.company ?? 'Harbor Dental', l.url ?? 'https://news.example/harbor-opens', l.date === undefined ? '2026-10-20' : l.date, l.dateStatus ?? 'verified',
        l.conf === undefined ? 80 : l.conf, l.review ?? null, l.domain === undefined ? 'harbordental.example' : l.domain, l.kind === undefined ? 'expansion' : l.kind, l.quarantined ? at : null, id])
    const enr = (connector: string, kind: string, value: string) => db.run('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [hex(), id, user, connector, kind, value, 'https://invalid.example/', '2026-10-30', at])
    if (l.reachable) await enr('scan:actionable', 'actionability', 'Actionable: domain, person and published contact confirmed')
    else if (!l.held) await enr('scan:actionable', 'actionability', 'Not actionable yet: no published contact')
    if (l.held) await enr('scan:gate', 'gate_failed', 'sales_hiring_check_failed')
  }
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [at, job])
  await collectMonitorResults(db, { now: at + 3600 })
  const r = (await db.get<{ id: string; new_count: number }>('SELECT id, new_count FROM monitor_runs WHERE job_id = ?', [job]))!
  const alerts = await db.all<{ kind: string; company: string }>('SELECT kind, company FROM monitor_alerts WHERE run_id = ? ORDER BY company, kind', [r.id])
  return { newCount: Number(r.new_count), kinds: alerts.map(a => a.kind) }
}

bothEngines('same company with a genuinely new event is surfaced once; repeated old news is suppressed', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  // the same event re-found next week, by another outlet, under another spelling of the company: not new
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ company: 'HARBOR DENTAL, Inc.', url: 'https://other.example/harbor' }]), { newCount: 0, kinds: [] })
  // a genuinely new, later event for the same company is surfaced once as a new signal
  const hire: L = { url: 'https://news.example/harbor-hires', date: '2026-11-02', kind: 'hiring' }
  assert.deepEqual(await run(db, 'u1', mon, NOW + 14 * DAY, [hire]), { newCount: 1, kinds: ['new_signal'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 21 * DAY, [hire, {}]), { newCount: 0, kinds: [] })
  // old news (outside the window) and future-dated events are never stored or alerted
  assert.deepEqual(await run(db, 'u1', mon, NOW + 28 * DAY, [{ company: 'Old Dental', domain: 'old.example', date: '2025-01-05' }, { company: 'Future Dental', domain: 'future.example', date: '2027-03-01' }]), { newCount: 0, kinds: [] })
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM monitor_events WHERE entity_key IN ('d:old.example', 'd:future.example')"))!.n), 0)
  const ev = await db.get<{ first_seen_at: number; last_checked_at: number; occurred_at: number }>("SELECT first_seen_at, last_checked_at, occurred_at FROM monitor_events WHERE user_id = 'u1' AND event_key LIKE '%|2026-10-20|%'")
  assert.deepEqual([Number(ev!.first_seen_at), Number(ev!.last_checked_at), Number(ev!.occurred_at)], [NOW + 3600, NOW + 21 * DAY + 3600, Date.parse('2026-10-20T00:00:00Z') / 1000], 'first seen / last checked are when the run was folded; occurred is the event day')
})

bothEngines('a blocked research item does not inflate new actionable leads; undated and unverified dates never surface', async ({ db }) => {
  const mon = await play(db, 'u1')
  const r = await run(db, 'u1', mon, NOW, [
    { review: 'blocked_by_site', conf: null },                                         // blocked research item
    { company: 'Quarantine Dental', domain: 'q.example', quarantined: true },
    { company: 'Held Dental', domain: 'held.example', held: true },                   // required gate failed, review write lost
    { company: 'Undated Dental', domain: 'undated.example', date: null, dateStatus: 'undated' },
    { company: 'Guess Dental', domain: 'guess.example', dateStatus: 'unverified' },
  ])
  assert.deepEqual(r, { newCount: 0, kinds: [] })
  // the same event once the pipeline verified it: surfaced, once
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 14 * DAY, [{}, { review: 'blocked_by_site', conf: null, company: 'Other', domain: 'other.example' }]), { newCount: 0, kinds: [] })
  // a company seen only as research (quarantined above) is still a NEW company when its first actionable event arrives
  assert.deepEqual(await run(db, 'u1', mon, NOW + 21 * DAY, [{ company: 'Quarantine Dental', domain: 'q.example', url: 'https://news.example/q2', date: '2026-11-05', kind: 'hiring' }]), { newCount: 1, kinds: ['new_company'] })
})

bothEngines('a newly verified contact triggers a state-change alert, once', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ reachable: true }]), { newCount: 1, kinds: ['now_reachable'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 14 * DAY, [{ reachable: true }]), { newCount: 0, kinds: [] })
  // reachable at first sight: one new_company alert, no later now_reachable for the same event
  assert.deepEqual(await run(db, 'u1', mon, NOW + 21 * DAY, [{ company: 'Cedar Vet', domain: 'cedar.example', reachable: true }]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 28 * DAY, [{ company: 'Cedar Vet', domain: 'cedar.example', reachable: true }]), { newCount: 0, kinds: [] })
})

bothEngines('alert policy: only the selected kinds alert; state is still tracked', async ({ db }) => {
  const mon = await play(db, 'u1', { policy: 'reachable' })
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{}, { company: 'Cedar Vet', domain: 'cedar.example', reachable: true }]), { newCount: 1, kinds: ['new_company'] })
  assert.equal((await db.get<{ company: string }>('SELECT company FROM monitor_alerts'))!.company, 'Cedar Vet')
  // the unreachable one was recorded (not re-alerted as new later) and alerts when its contact is confirmed
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ reachable: true }]), { newCount: 1, kinds: ['now_reachable'] })
  const only = await play(db, 'u2', { policy: 'new_companies' })
  assert.deepEqual(await run(db, 'u2', only, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u2', only, NOW + 7 * DAY, [{ reachable: true }, { url: 'https://news.example/h2', date: '2026-11-02', kind: 'hiring' }]), { newCount: 0, kinds: [] })
  assert.equal((await listMonitors(db, 'u2'))[0].alert_policy, 'new_companies')
})

bothEngines('deduped across plays, isolated across tenants', async ({ db }) => {
  const a = await play(db, 'u1'), b = await play(db, 'u1', { query: 'clinics expanding in Bristol' })
  assert.deepEqual(await run(db, 'u1', a, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', b, NOW + DAY, [{}]), { newCount: 0, kinds: [] }, 'another play does not alert the same event again')
  const other = await play(db, 'u2')
  assert.deepEqual(await run(db, 'u2', other, NOW + DAY, [{}]), { newCount: 1, kinds: ['new_company'] }, 'another tenant has its own state')
})

bothEngines("the play's own window rules what is old news", async ({ db }) => {
  const mon = await play(db, 'u1', { query: 'dental practices that opened a location in the past 30 days' })
  assert.equal(monitorWindowDays({ query: 'dental practices that opened a location in the past 30 days', icp: null }), 30)
  // 40 days before the run: inside the 90-day default, outside this play's 30 days
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{ date: '2026-09-20' }, { company: 'Fresh Dental', domain: 'fresh.example', date: '2026-10-25' }]), { newCount: 1, kinds: ['new_company'] })
})

bothEngines('missed runs: one catch-up scan, never one per missed slot; latency, recovery and cursors are reported', async ({ db }) => {
  const mon = await play(db, 'u1')
  await run(db, 'u1', mon, NOW, [{}])
  // the tick did not run for three weekly slots: the late run is ONE scan (no extra paid calls) that records the gap
  await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [NOW + 7 * DAY, mon])
  const before = Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs'))!.n)
  const jobs = await runDueMonitors(db, { now: NOW + 28 * DAY })
  assert.equal(jobs.length, 1)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs'))!.n), before + 1)
  assert.deepEqual(await runDueMonitors(db, { now: NOW + 28 * DAY }), [], 'nothing else is due until the next interval')
  assert.equal(Number((await db.get<{ m: number }>('SELECT missed_runs AS m FROM monitor_runs WHERE job_id = ?', [jobs[0]]))!.m), 3)
  const rep = await detectionReport(db, 'u1', mon, monitorWindowDays({ query: 'dental practices opening a new location', icp: null }))
  assert.deepEqual(rep.by_kind, { new_company: 1, new_signal: 0, now_reachable: 0 })
  assert.equal(rep.latency.median_s, NOW + 3600 - Date.parse('2026-10-20T00:00:00Z') / 1000, 'event day -> alert')
  assert.deepEqual(rep.last_run && [rep.last_run.missed_runs, rep.last_run.uncovered_days], [3, 0], '28 days late is still inside the 90-day window')
  assert.deepEqual(rep.sources, [{ source: 'news.example', last_event_at: Date.parse('2026-10-20T00:00:00Z') / 1000, last_checked_at: NOW + 3600 }])
  assert.deepEqual((await detectionReport(db, 'u2', mon, 90)).sources, [], "another tenant reads nothing of this monitor")
})

bothEngines('a run is folded only after its enrichment settles, so a contact confirmed by the scan is reachable at first sight', async ({ db }) => {
  const mon = await play(db, 'u1')
  await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [NOW, mon])
  const [job] = await runDueMonitors(db, { now: NOW })
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, event_date, date_status, confidence, company_domain) VALUES (?, ?, '', 'Harbor Dental', 's', 'https://news.example/a', '2026-10-20', 'verified', 80, 'harbordental.example')", [hex(), job])
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_started_at = ? WHERE id = ?", [NOW, NOW, job])
  assert.equal(await collectMonitorResults(db, { now: NOW + 60 }), 0)
  assert.equal(Number((await db.get<{ p: number }>('SELECT processed AS p FROM monitor_runs WHERE job_id = ?', [job]))!.p), 0, 'still enriching: not folded yet')
  await db.run('UPDATE scan_jobs SET enrich_finished_at = ? WHERE id = ?', [NOW + 120, job])
  assert.equal(await collectMonitorResults(db, { now: NOW + 180 }), 1)
})

test('pure rules: keys are spelling-independent; undated, out-of-window and unverified leads never alert', () => {
  const l: RunLead = { company: 'Harbor Dental', company_domain: null, event_date: '2026-10-20', date_status: 'verified', signal_kind: 'expansion', source_url: 'https://a.example/x', review_reason: null, confidence: 80, quarantined_at: null, held: false, reachable: false }
  assert.equal(entityKeyOf({ company: 'HARBOR Dental, Inc', company_domain: null }), entityKeyOf({ company: 'harbor dental', company_domain: null }))
  assert.equal(entityKeyOf({ company: 'x', company_domain: 'https://www.Harbor.example/about' }), 'd:harbor.example')
  assert.equal(eventKeyOf(l), eventKeyOf({ ...l, source_url: 'https://b.example/y' }))
  assert.notEqual(eventKeyOf(l), eventKeyOf({ ...l, event_date: '2026-10-21' }))
  const W = DEFAULT_EVENT_WINDOW_DAYS
  assert.deepEqual(decide({ ...l, date_status: 'unverified' }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date: null }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date: '2026-02-30' }, null, false, 'all', W, NOW), { suppress: 'out_of_window' })
  assert.deepEqual(decide({ ...l, review_reason: 'quote_unconfirmed', confidence: null }, null, false, 'all', W, NOW), { suppress: 'not_actionable' })
  assert.deepEqual(decide({ ...l, held: true }, null, false, 'all', W, NOW), { suppress: 'not_actionable' })
  assert.deepEqual(decide(l, null, true, 'all', W, NOW), { kind: 'new_signal', alert: true })
  assert.deepEqual(decide(l, null, true, 'new_companies', W, NOW), { kind: 'new_signal', alert: false })
  assert.deepEqual(decide({ ...l, reachable: true }, { actionable_at: 1, reachable_at: null }, true, 'reachable', W, NOW), { kind: 'now_reachable', alert: true })
  assert.deepEqual(decide(l, { actionable_at: 1, reachable_at: null }, true, 'all', W, NOW), { suppress: 'already_seen' })
})

test('missed-run arithmetic', () => {
  assert.equal(missedRuns(NOW, NOW + 60, 168), 0)
  assert.equal(missedRuns(NOW, NOW + 21 * DAY, 168), 3)
  assert.equal(uncoveredDays(null, NOW, 90), 0)
  assert.equal(uncoveredDays(NOW - 100 * DAY, NOW, 90), 10)
})
