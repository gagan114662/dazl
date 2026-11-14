// #1193 (found by the Hermes-PC review of PR #1166): the monitor's alert record (play_alerts, #883) must agree with its event rows
// (monitor_events): a board-dated posting is one event whatever the grader labelled it. Each direction, the controls, and the rows an
// older deploy wrote with a raw grade. The helpers are the reviewer's probe's (test/rv1166-xlayer.test.ts, kept unchanged beside this file).
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


const HIRING_LABELS = ['hiring', 'hiring_relevant_role', 'open_role_language', 'growing_team', 'job_board_presence']
const heldKind = (db: Db) => db.get<{ signal_kind: string | null }>("SELECT signal_kind FROM play_alerts WHERE tenant_id = ? AND entity_key = 'd:flexport.com'", [A])
async function weekly(db: Db, kind: string | null) {
  const w = await createWatch(db, A, Q, ICP, null, NOW - 3 * DAY)
  assert.ok(w.watch, JSON.stringify(w))
  await db.run('UPDATE watches SET created_at = ? WHERE id = ?', [NOW - 3 * DAY, w.watch.id])
  await watchRun(db, w.watch.id, Q, NOW, [{ kind }])
  return w.watch.id
}

test('#1193 weekly play -> monitor: whichever hiring label the play mailed the posting under, a relabel by the monitor is not a new alert (every pair)', async () => {
  for (const mailed of HIRING_LABELS) for (const found of HIRING_LABELS) {
    const { db } = await open()
    await weekly(db, mailed)
    const m = await createMonitor(db, A, { query: Q2 }, NOW)
    assert.ok('id' in m)
    assert.deepEqual(await monitorRun(db, m.id, NOW + DAY, [{ kind: found }]), [], `mailed as ${mailed}, found as ${found}`)
  }
})

test('#1193 weekly play -> monitor: an ungraded sighting on either side is the same event; a later proven day alerts once', async () => {
  for (const [mailed, found] of [[null, 'hiring_relevant_role'], ['job_board_presence', null], [null, null]] as const) {
    const { db } = await open()
    await weekly(db, mailed)
    const m = await createMonitor(db, A, { query: Q2 }, NOW)
    assert.ok('id' in m)
    assert.deepEqual(await monitorRun(db, m.id, NOW + DAY, [{ kind: found }]), [], `mailed ${mailed}, found ${found}`)
    const later = { kind: 'hiring', date: '2026-11-18', url: 'https://job-boards.greenhouse.io/flexport/jobs/8400001', signal: 'Flexport is hiring a Strategic Account Executive' }
    assert.deepEqual((await monitorRun(db, m.id, NOW + 6 * DAY, [later])).map(a => a.kind), ['new_signal'])
    assert.deepEqual(await monitorRun(db, m.id, NOW + 13 * DAY, [later]), [])
  }
})

test('#1193 weekly play -> monitor: another event stays another event (not a company-level mute)', async () => {
  // the play mailed Flexport as an EXPANSION on that day: the monitor's hiring posting of the same day is a different event
  const { db } = await open()
  await weekly(db, 'expansion')
  const m = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in m)
  assert.deepEqual((await monitorRun(db, m.id, NOW + DAY, [{ kind: 'hiring' }])).map(a => a.kind), ['new_signal'])
})

test('#1193 monitor -> weekly play: the monitor records the posting as a hiring event whatever the grade, and the play does not mail it as new after a relabel', async () => {
  const { db } = await open()
  const m = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in m)
  assert.deepEqual((await monitorRun(db, m.id, NOW + DAY, [{ kind: 'job_board_presence' }])).map(a => a.kind), ['new_company'])
  assert.deepEqual(await heldKind(db), { signal_kind: 'hiring' }, 'the alert record holds the normalised kind, not the raw grade')
  const w = await createWatch(db, A, Q, ICP, null, NOW + 2 * DAY)
  assert.ok(w.watch)
  await db.run('UPDATE watches SET created_at = ? WHERE id = ?', [NOW + 2 * DAY, w.watch.id])
  await watchRun(db, w.watch.id, Q, NOW + 3 * DAY, [{ kind: 'hiring_relevant_role' }])
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM leads WHERE watch_new = 1"))!.n), 0, 'the play does not count the already-alerted posting as new')
})

test('#1193 monitor -> monitor: a second monitor finding the posting under another grade does not alert it again; the record keeps one holder', async () => {
  const { db } = await open()
  const a = await createMonitor(db, A, { query: Q }, NOW)
  const b = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in a && 'id' in b)
  assert.deepEqual((await monitorRun(db, a.id, NOW + DAY, [{ kind: 'hiring' }])).map(x => x.kind), ['new_company'])
  assert.deepEqual(await monitorRun(db, b.id, NOW + 2 * DAY, [{ kind: 'job_board_presence' }]), [])
  assert.deepEqual(await monitorRun(db, b.id, NOW + 9 * DAY, [{ kind: 'hiring_relevant_role' }]), [])
  const rows = await db.all<{ entity_key: string; play_kind: string; signal_kind: string | null }>('SELECT entity_key, play_kind, signal_kind FROM play_alerts WHERE tenant_id = ?', [A])
  const company = rows.filter(r => r.entity_key !== '~seeded')   // '~seeded' is the once-per-account backfill marker
  assert.ok(company.length === 2 && company.every(r => r.signal_kind === 'hiring' && r.play_kind === 'monitor'), `the company's two keys hold the one normalised alert: ${JSON.stringify(rows)}`)
})

test('#1193 a page-proven day is not collapsed: two different labelled kinds on one day are still two events (#883)', async () => {
  const { db } = await open()
  await weekly(db, 'raised_funding')
  const m = await createMonitor(db, A, { query: Q2 }, NOW)
  assert.ok('id' in m)
  // a page-proven (not board-dated) lead with another labelled kind on that day is another event, as #883 has it
  assert.deepEqual((await monitorRun(db, m.id, NOW + DAY, [{ kind: 'expansion', proof: 'page_bound', signal: 'Flexport opened a depot' }])).map(x => x.kind), ['new_signal'])
})
