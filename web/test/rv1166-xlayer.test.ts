// Hermes-PC reviewer lane, PR #1166 at 4f11e4a4. NOT for merge: this file is the reviewer's own probe of the four
// collision points between #1166 (#882/#759) and #1162 (#883), which landed on main and rewrote the same files.
// It imports nothing that only one side has, so the SAME file runs against origin/main's lib and against the branch's.
// SQLite only, in-memory, no network, no provider, no paid call.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import type { Db } from '../lib/db/client.ts'
import { createWatch, writeWatchLeads } from '../lib/watch.ts'
import { sendPlayRunMails } from '../lib/play-mail.ts'
import { createMonitor, runDueMonitors, collectMonitorResults } from '../lib/monitors.ts'

const DAY = 86400
const NOW = Math.floor(Date.parse('2026-11-13T12:00:00Z') / 1000)
const D = '2026-11-12'                 // the Greenhouse posting's own publish day, inside the window
const A = 'a'.repeat(32)
let n = 0
const id24 = () => (++n).toString(16).padStart(24, '0')
const ICP = JSON.stringify({ summary: 'B2B software', who: ['Head of Sales'], industries: ['B2B SaaS'], sizes: ['50-500 employees'], where: ['United States'], signals: ['hiring an account executive'], exclude: [] })
const Q = 'B2B software companies hiring account executives'
const Q2 = 'software companies that just opened an AE role'

// The real staging Flexport row (step 8's data), with the fit grade raised to 3 so the Leads list SHOWS it: the
// board-dated hiring posting whose GRADED KIND is the thing that changes from run to run.
interface L { company?: string; domain?: string | null; date?: string | null; proof?: string | null; legacyStatus?: string; signal?: string; kind?: string | null; signals?: string[] | null; url?: string; fit?: number | null }
const FLEX = {
  company: 'Flexport', domain: 'flexport.com', date: D, proof: 'ats_structured',
  signal: 'Flexport is hiring an Account Executive for Enterprise',
  url: 'https://job-boards.greenhouse.io/flexport/jobs/8383190', fit: 3,
}

async function open(): Promise<{ db: Db; raw: Database.Database }> {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, 'founder@a.example', 'n', 'b', 'x', 'y')", [A])
  await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [NOW - 30 * DAY, A])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, '', 'personal', ?, ?)", [A, A, NOW - 30 * DAY])
  await db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [A])
  return { db, raw }
}

// A stored lead exactly as the scanner writes a board-proven day today: date_status 'unverified', event_date_proof
// 'ats_structured'. `legacyStatus` writes the pre-2026-10-23 'verified' instead, which is the ONLY thing main's
// detector reads: it lets the same case alert on main too, so a difference in the counts is the dedupe, not the detector.
async function addLead(db: Db, job: string, l: L): Promise<string> {
  const id = id24()
  await db.run(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score, fit, event_date, date_status, event_date_proof, confidence, review_reason, signal_kind, signals, dedup_key)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [id, job, l.company ?? FLEX.company, l.domain === undefined ? FLEX.domain : l.domain, l.signal ?? FLEX.signal, l.url ?? FLEX.url, 85,
      l.fit === undefined ? FLEX.fit : l.fit, l.date === undefined ? D : l.date, l.legacyStatus ?? 'unverified',
      l.proof === undefined ? FLEX.proof : l.proof, 60, l.kind ?? null, l.signals ? JSON.stringify(l.signals) : null, id])
  return id
}

// One run of a weekly / daily play, through the production steps up to and including the mail pass that claims.
async function watchRun(db: Db, watch: string, query: string, at: number, leads: L[]): Promise<void> {
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, created_at, watch_id) VALUES (?, ?, 'x', '-', '-', ?, ?, 'running', ?, ?)", [id, A, query, ICP, at - 300, watch])
  for (const l of leads) await addLead(db, id, l)
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_started_at = ?, enrich_finished_at = ? WHERE id = ?", [at, at, at, id])
  await writeWatchLeads(db, watch, id)
  await sendPlayRunMails(db, { now: at + 60 })
}

// One scheduled monitor run that stored `leads`, then the tick's fold. Returns the alerts that run wrote.
async function monitorRun(db: Db, mon: string, at: number, leads: L[]): Promise<{ kind: string; company: string; event_key: string }[]> {
  await db.run('UPDATE monitors SET next_run_at = CASE WHEN id = ? THEN ? ELSE 9999999999 END', [mon, at])
  const jobs = await runDueMonitors(db, { now: at })
  assert.equal(jobs.length, 1, 'one due monitor ran')
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [jobs[0]])
  for (const l of leads) {
    const id = await addLead(db, jobs[0], l)
    await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'scan:actionable', 'actionability', 'Not actionable yet: no published contact', 'https://invalid.example/', '2026-11-13', ?)", [id24(), id, A, at])
  }
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [at, jobs[0]])
  await collectMonitorResults(db, { now: at + 3600 })
  return db.all<{ kind: string; company: string; event_key: string }>(
    'SELECT a.kind, a.company, a.event_key FROM monitor_alerts a JOIN monitor_runs r ON r.id = a.run_id WHERE r.job_id = ? ORDER BY a.company, a.kind', [jobs[0]])
}
const allAlerts = (db: Db) => db.all<{ kind: string; event_key: string }>("SELECT kind, event_key FROM monitor_alerts WHERE user_id = ? ORDER BY at, event_key", [A])
const events = (db: Db) => db.all<{ event_key: string }>("SELECT event_key FROM monitor_events WHERE user_id = ? ORDER BY event_key", [A])

// ---- POINT 1: layer 1 (monitor_events.event_key). main's eventKeyOf carries the graded signal_kind -----------------
// The grader names a different first signal for the SAME Greenhouse posting on each run. legacyStatus 'verified' is set
// so main's detector alerts too; the question is only whether run 2 alerts AGAIN.
test('P1 layer 1: one board-dated posting relabelled by the grader on each run is ONE event and ONE alert', async () => {
  const { db } = await open()
  const m = await createMonitor(db, A, { query: Q }, NOW)
  assert.ok('id' in m, JSON.stringify(m))
  const r1 = await monitorRun(db, m.id, NOW + DAY, [{ kind: 'job_board_presence', legacyStatus: 'verified' }])
  assert.deepEqual(r1.map(a => a.kind), ['new_company'], 'run 1 alerts once')
  const r2 = await monitorRun(db, m.id, NOW + 8 * DAY, [{ kind: 'hiring_relevant_role', legacyStatus: 'verified' }])
  assert.deepEqual(r2, [], 'run 2: the same posting, relabelled, is not a new event')
  const r3 = await monitorRun(db, m.id, NOW + 15 * DAY, [{ kind: 'hiring', legacyStatus: 'verified' }])
  assert.deepEqual(r3, [], 'run 3: relabelled again, still not a new event')
  const r4 = await monitorRun(db, m.id, NOW + 22 * DAY, [{ kind: null, legacyStatus: 'verified' }])
  assert.deepEqual(r4, [], 'run 4: the grader did not label it at all, still not a new event')
  assert.equal((await allAlerts(db)).length, 1, `one alert in total, got ${JSON.stringify(await allAlerts(db))}`)
  assert.equal((await events(db)).length, 1, `one event row in total, got ${JSON.stringify(await events(db))}`)
})

// ---- POINT 4: foldRunEvents' jobId; several leads of one event in ONE run ------------------------------------------
test('P4 one run that returns the same event twice (two same-day postings) raises one alert', async () => {
  const { db } = await open()
  const m = await createMonitor(db, A, { query: Q }, NOW)
  assert.ok('id' in m)
  const r = await monitorRun(db, m.id, NOW + DAY, [
    { kind: 'job_board_presence', legacyStatus: 'verified' },
    { kind: 'hiring', legacyStatus: 'verified', url: 'https://job-boards.greenhouse.io/flexport/jobs/8383191', signal: 'Flexport is hiring an Account Executive for Mid-Market' },
  ])
  assert.deepEqual(r.map(a => a.kind), ['new_company'], `one alert for the company's one event day, got ${JSON.stringify(r)}`)
})

// ---- POINTS 2 + 3: the two layers must AGREE ----------------------------------------------------------------------
// Layer 2 is the tenant's alert record (#883 play_alerts): claimAlertStep PERSISTS the raw signal_kind and sameEventAs
// compares raw signal_kinds. Layer 1 (above) collapses every graded kind of a board-dated lead to 'hiring'.
// So: a weekly play mails the posting under one graded kind, then the monitor finds THE SAME posting under another.
// Layer 1 cannot help here (it has no row of its own for that event yet): only layer 2 decides.
test('P2/P3 the two layers agree: a weekly play mailed the posting; the monitor must not alert it again after a relabel', async () => {
  const { db } = await open()
  const w = await createWatch(db, A, Q, ICP, null, NOW - 3 * DAY)
  assert.ok(w.watch, JSON.stringify(w))
  await db.run('UPDATE watches SET created_at = ? WHERE id = ?', [NOW - 3 * DAY, w.watch.id])
  // the weekly play mails Flexport: the record holds it with event_date 2026-11-12 and signal_kind 'job_board_presence'
  await watchRun(db, w.watch.id, Q, NOW, [{ kind: 'job_board_presence', legacyStatus: 'verified' }])
  const held = await db.get<{ event_date: string; signal_kind: string }>("SELECT event_date, signal_kind FROM play_alerts WHERE tenant_id = ? AND entity_key = 'd:flexport.com'", [A])
  assert.deepEqual(held, { event_date: D, signal_kind: 'job_board_presence' }, 'the mail pass claimed the company for this event')
  // the monitor now returns the SAME posting; its grade moved to another hiring label
  const m = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in m, JSON.stringify(m))
  const r = await monitorRun(db, m.id, NOW + DAY, [{ kind: 'hiring_relevant_role', legacyStatus: 'verified' }])
  assert.deepEqual(r, [], `the weekly play already told the user about this posting: a relabel is not a new event. Got ${JSON.stringify(r)}`)
})

test('P2/P3 control: the same posting under the SAME graded kind is already recognised', async () => {
  const { db } = await open()
  const w = await createWatch(db, A, Q, ICP, null, NOW - 3 * DAY)
  assert.ok(w.watch)
  await db.run('UPDATE watches SET created_at = ? WHERE id = ?', [NOW - 3 * DAY, w.watch.id])
  await watchRun(db, w.watch.id, Q, NOW, [{ kind: 'job_board_presence', legacyStatus: 'verified' }])
  const m = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in m)
  assert.deepEqual(await monitorRun(db, m.id, NOW + DAY, [{ kind: 'job_board_presence', legacyStatus: 'verified' }]), [], 'same kind: suppressed')
})

// A day-moved event: the posting the scan proved on another day IS a new event (so the suppression above must not be
// a blanket company-level mute). Keeps the two cases apart.
test('P2/P3 a genuinely different event day for the same company still alerts, once', async () => {
  const { db } = await open()
  const w = await createWatch(db, A, Q, ICP, null, NOW - 3 * DAY)
  assert.ok(w.watch)
  await db.run('UPDATE watches SET created_at = ? WHERE id = ?', [NOW - 3 * DAY, w.watch.id])
  await watchRun(db, w.watch.id, Q, NOW, [{ kind: 'job_board_presence', legacyStatus: 'verified' }])
  const m = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in m)
  const later = { kind: 'hiring', legacyStatus: 'verified', date: '2026-11-18', url: 'https://job-boards.greenhouse.io/flexport/jobs/8400001', signal: 'Flexport is hiring a Strategic Account Executive' }
  const r = await monitorRun(db, m.id, NOW + 6 * DAY, [later])
  assert.deepEqual(r.map(a => a.kind), ['new_signal'], `a later proven event day is a new signal, got ${JSON.stringify(r)}`)
  assert.deepEqual(await monitorRun(db, m.id, NOW + 13 * DAY, [later]), [], 'and only once')
})
