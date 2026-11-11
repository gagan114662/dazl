// #1042: a saved play's "Find leads now" (pulls its next scheduled run forward, under the scheduled run's rules made
// stricter) and its "new since you last checked" list. Both engines; synthetic rows only, no network, no paid call: the
// run only QUEUES a job, exactly as the scheduler does, and nothing here runs the scan pipeline.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bothEngines } from './helpers/engines.ts'
import { createWatch, runDueWatches, watchAction } from '../lib/watch.ts'
import { createMonitor, runDueMonitors, setMonitorEnabled } from '../lib/monitors.ts'
import { runPlayNow, playNew, RUN_NOW_MIN_GAP_S, NEW_LIMIT } from '../lib/play-now.ts'
import { newLabel, parseSeen, readSeen, runNowMessage, writeSeen, seenKey } from '../lib/play-new-view.ts'
import { savedPlays } from '../lib/saved-plays.ts'
import type { Db } from '../lib/db/client.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const DAY = 86400
// "now" is the real clock (the monthly quota counts from the current month), the fixtures sit around it
const NOW = Math.floor(Date.now() / 1000)
let n = 0
const id24 = () => (++n).toString(16).padStart(24, '0')
const giveKey = (db: Db, t: string) => db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [t])
const jobs = async (db: Db, t: string) => (await db.all<{ id: string; watch_id: string | null; query: string; status: string; funded_by: string | null }>('SELECT id, watch_id, query, status, funded_by FROM scan_jobs WHERE user_id = ? ORDER BY created_at, insert_seq', [t]))
const finish = async (db: Db, id: string) => { await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ? AND status = 'pending'", [id]); await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [NOW, id]) }

bothEngines('#1042 Find leads now on a monitor queues one job the scheduler would have, moves the next run, and records the run', async ({ db }) => {
  const m = await createMonitor(db, A, { query: 'Dental practices in Leeds hiring a practice manager' }, NOW - DAY)
  assert.ok('id' in m)
  await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [NOW + 3 * DAY, m.id]) // not due yet
  await giveKey(db, A)
  const r = await runPlayNow(db, A, 'monitor', m.id, NOW)
  assert.ok('job_id' in r, JSON.stringify(r))
  const mon = await db.get<{ last_run_at: number; next_run_at: number; interval_hours: number }>('SELECT last_run_at, next_run_at, interval_hours FROM monitors WHERE id = ?', [m.id])
  assert.equal(Number(mon!.last_run_at), NOW)
  assert.equal(Number(mon!.next_run_at), NOW + Number(mon!.interval_hours) * 3600, 'the next scheduled run moved: a click replaces it, never adds one')
  assert.equal(r.next_run_at, Number(mon!.next_run_at))
  const js = await jobs(db, A)
  assert.deepEqual(js.map(j => [j.id, j.query, j.status, j.funded_by]), [[r.job_id, 'Dental practices in Leeds hiring a practice manager', 'pending', 'user']], 'one job, own-key funded, never trial')
  const runs = await db.all<{ job_id: string; missed_runs: number }>('SELECT job_id, missed_runs FROM monitor_runs WHERE monitor_id = ?', [m.id])
  assert.deepEqual(runs.map(x => [x.job_id, Number(x.missed_runs)]), [[r.job_id, 0]])
  // the scheduler's next tick does nothing for it now: not due until the moved time
  assert.deepEqual(await runDueMonitors(db, { now: NOW + 60 }), [])
})

bothEngines('#1042 Find leads now on a weekly play queues its job with the watch and its budget, and the week restarts', async ({ db }) => {
  const w = (await createWatch(db, A, 'Roofers in Ohio hiring estimators', '{"summary":"Roofing contractors"}', '{"max_usd":2}', NOW - DAY)).watch!
  await giveKey(db, A)
  const r = await runPlayNow(db, A, 'watch', w.id, NOW)
  assert.ok('job_id' in r, JSON.stringify(r))
  const j = await db.get<{ watch_id: string; run_budget: string | null; icp: string }>('SELECT watch_id, run_budget, icp FROM scan_jobs WHERE id = ?', [r.job_id])
  assert.deepEqual([j!.watch_id, j!.run_budget, j!.icp], [w.id, '{"max_usd":2}', '{"summary":"Roofing contractors"}'])
  const row = await db.get<{ next_run_at: number; last_run_at: number }>('SELECT next_run_at, last_run_at FROM watches WHERE id = ?', [w.id])
  assert.deepEqual([Number(row!.last_run_at), Number(row!.next_run_at)], [NOW, NOW + 7 * DAY])
})

bothEngines('#1042 refusals write nothing and pause nothing: other tenant, paused, no key, no quota, a scan running, just ran', async ({ db }) => {
  const m = await createMonitor(db, A, { query: 'Accounting firms in Bristol hiring payroll staff' }, NOW - DAY)
  assert.ok('id' in m)
  const w = (await createWatch(db, A, 'Physio clinics in Manchester', '{"summary":"s"}', null, NOW - DAY)).watch!
  const snap = async () => JSON.stringify([await db.all('SELECT * FROM monitors ORDER BY id'), await db.all('SELECT * FROM watches ORDER BY id'), await db.all('SELECT id FROM scan_jobs ORDER BY id'), await db.all('SELECT id FROM monitor_runs ORDER BY id')])
  const before = await snap()
  // another tenant's play, unknown ids and kinds: not found (B has a key, so this is not the key refusal)
  await giveKey(db, B)
  assert.deepEqual(await runPlayNow(db, B, 'monitor', m.id, NOW), { error: 'not_found' })
  assert.deepEqual(await runPlayNow(db, B, 'watch', w.id, NOW), { error: 'not_found' })
  assert.deepEqual(await runPlayNow(db, A, 'watch', m.id, NOW), { error: 'not_found' }, 'a monitor id under the watch kind')
  assert.deepEqual(await runPlayNow(db, A, 'monitor', id24(), NOW), { error: 'not_found' })
  assert.deepEqual(await runPlayNow(db, A, 'campaign' as never, m.id, NOW), { error: 'not_found' })
  // no key of its own: refused, the play stays live (the scheduler would have paused a keyless watch; a click must not)
  assert.deepEqual(await runPlayNow(db, A, 'watch', w.id, NOW), { error: 'no_api_key' })
  assert.deepEqual(await runPlayNow(db, A, 'monitor', m.id, NOW), { error: 'no_api_key' })
  assert.equal(await snap(), before)
  await giveKey(db, A)
  // paused
  await setMonitorEnabled(db, A, m.id, false); await watchAction(db, A, w.id, 'pause')
  const paused = await snap()
  assert.deepEqual(await runPlayNow(db, A, 'monitor', m.id, NOW), { error: 'paused' })
  assert.deepEqual(await runPlayNow(db, A, 'watch', w.id, NOW), { error: 'paused' })
  assert.equal(await snap(), paused)
  await setMonitorEnabled(db, A, m.id, true); await watchAction(db, A, w.id, 'resume', NOW - DAY)
  // a scan of the account is running: one at a time
  const busy = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '-', '-', 'q', 'running', ?)", [busy, A, NOW])
  const running = await snap()
  assert.deepEqual(await runPlayNow(db, A, 'monitor', m.id, NOW), { error: 'scan_active' })
  assert.equal(await snap(), running)
  await finish(db, busy)
  // monthly scans used up (free: 50): refused, not paused (the scheduler pauses with a reason; a click only answers)
  for (let i = 0; i < 50; i++) await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at, funded_by) VALUES (?, ?, 'x', '-', '-', 'q', 'done', ?, 'user')", [id24(), A, NOW - 60])
  const full = await snap()
  assert.deepEqual(await runPlayNow(db, A, 'monitor', m.id, NOW), { error: 'quota_exceeded' })
  assert.equal(await snap(), full)
  assert.equal(Number((await db.get<{ enabled: number }>('SELECT enabled FROM monitors WHERE id = ?', [m.id]))!.enabled), 1, 'still live')
})

bothEngines('#1042 just ran: refused until RUN_NOW_MIN_GAP_S has passed; a replayed click makes one job', async ({ db }) => {
  const m = await createMonitor(db, A, { query: 'Law firms in Toronto opening offices' }, NOW - DAY)
  assert.ok('id' in m)
  await giveKey(db, A)
  const first = await runPlayNow(db, A, 'monitor', m.id, NOW)
  assert.ok('job_id' in first)
  // the replay of the same click while its job is queued
  assert.deepEqual(await runPlayNow(db, A, 'monitor', m.id, NOW + 1), { error: 'too_soon', retry_at: NOW + RUN_NOW_MIN_GAP_S })
  await finish(db, first.job_id)
  assert.deepEqual(await runPlayNow(db, A, 'monitor', m.id, NOW + RUN_NOW_MIN_GAP_S - 1), { error: 'too_soon', retry_at: NOW + RUN_NOW_MIN_GAP_S })
  const again = await runPlayNow(db, A, 'monitor', m.id, NOW + RUN_NOW_MIN_GAP_S)
  assert.ok('job_id' in again, JSON.stringify(again))
  assert.equal((await jobs(db, A)).length, 2)
})

bothEngines('#1042 a click racing the scheduler tick (or another click) creates ONE job for the due run', async ({ db }) => {
  const m = await createMonitor(db, A, { query: 'Plumbers in Leeds hiring apprentices' }, NOW - 2 * DAY) // due since creation
  assert.ok('id' in m)
  await giveKey(db, A)
  const [click, tick] = await Promise.all([runPlayNow(db, A, 'monitor', m.id, NOW), runDueMonitors(db, { now: NOW })])
  const made = (await jobs(db, A)).length
  assert.equal(made, 1, `one job, not two (click ${JSON.stringify(click)}, tick ${JSON.stringify(tick)})`)
  const w = (await createWatch(db, B, 'Bakeries in Paris', '{"summary":"s"}', null, NOW - 8 * DAY)).watch!
  await giveKey(db, B)
  const both = await Promise.all([runPlayNow(db, B, 'watch', w.id, NOW), runPlayNow(db, B, 'watch', w.id, NOW), runDueWatches(db, { now: NOW + 8 * DAY })])
  assert.equal((await jobs(db, B)).length, 1, `one job for B's watch: ${JSON.stringify(both)}`)
})

bothEngines("#1042 what's new: a weekly play's first-seen leads and a monitor's alerts since the given time; tenant-scoped", async ({ db }) => {
  const w = (await createWatch(db, A, 'Dental practices in Leeds', '{"summary":"s"}', null, NOW - 30 * DAY)).watch!
  const job = async (at: number, status: string, leads: [string, boolean][]) => {
    const id = id24()
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at, watch_id) VALUES (?, ?, 'x', '-', '-', 'q', 'running', ?, ?)", [id, A, at, w.id])
    for (const [co, nw] of leads) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, watch_new, score) VALUES (?, ?, ?, 'opening a second site', 'https://n.example/a', ?, 50)", [id24(), id, co, nw ? 1 : 0])
    if (status !== 'running') await db.run('UPDATE scan_jobs SET status = ? WHERE id = ?', [status, id])
    return id
  }
  const j1 = await job(NOW - 14 * DAY, 'done', [['Old Co', true], ['Seen Co', false]])
  const j2 = await job(NOW - 7 * DAY, 'done', [['Smile Leeds', true], ['Seen Co', false], ['Bright Teeth', true]])
  await job(NOW - DAY, 'running', [['Not finished Co', true]]) // unfinished: not counted yet, like the run's own count
  const all = await playNew(db, A, 'watch', w.id, 0)
  assert.deepEqual([all!.total, all!.latest_at, all!.items.map(i => [i.job_id, i.company])], [3, NOW - 7 * DAY, [[j2, 'Smile Leeds'], [j2, 'Bright Teeth'], [j1, 'Old Co']]], 'newest run first, then score, then insertion')
  const since = await playNew(db, A, 'watch', w.id, NOW - 14 * DAY)
  assert.deepEqual([since!.total, since!.items.map(i => i.company).sort()], [2, ['Bright Teeth', 'Smile Leeds']], 'only runs after the last check')
  assert.deepEqual(await playNew(db, A, 'watch', w.id, NOW - 7 * DAY), { since: NOW - 7 * DAY, total: 0, latest_at: null, seen_through: null, truncated: false, items: [] })
  // tenant scope, kind and input checks
  assert.equal(await playNew(db, B, 'watch', w.id, 0), null)
  assert.equal(await playNew(db, A, 'monitor', w.id, 0), null)
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) assert.equal(await playNew(db, A, 'watch', w.id, bad), null, String(bad))
  // monitor: its alerts are its new items, with a plain description of each kind
  const m = await createMonitor(db, A, { query: 'Accounting firms in Bristol' }, NOW - 30 * DAY)
  assert.ok('id' in m)
  const mj = id24(), run = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '-', '-', 'q', 'done', ?)", [mj, A, NOW - 2 * DAY])
  await db.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, processed, new_count) VALUES (?, ?, ?, ?, 1, 2)', [run, m.id, mj, NOW - 2 * DAY])
  for (const [co, kind] of [['Ledger & Co', 'new_company'], ['Sums Ltd', 'now_reachable']]) await db.run('INSERT INTO monitor_alerts (id, user_id, monitor_id, run_id, event_key, kind, company, latency_s, at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)', [id24(), A, m.id, run, `e:${co}`, kind, co, NOW - 2 * DAY])
  const mn = await playNew(db, A, 'monitor', m.id, 0)
  assert.deepEqual([mn!.total, mn!.latest_at, mn!.items.map(i => [i.job_id, i.company, i.what]).sort()], [2, NOW - 2 * DAY, [[mj, 'Ledger & Co', 'New company with a dated signal'], [mj, 'Sums Ltd', 'Now reachable: contact route confirmed']]])
  assert.equal(await playNew(db, B, 'monitor', m.id, 0), null)
})

bothEngines(`#1042 what's new lists at most NEW_LIMIT items and says how many there are`, async ({ db }) => {
  const w = (await createWatch(db, A, 'Gyms in Austin', '{"summary":"s"}', null, NOW - 30 * DAY)).watch!
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at, watch_id) VALUES (?, ?, 'x', '-', '-', 'q', 'running', ?, ?)", [id, A, NOW - DAY, w.id])
  for (let i = 0; i < NEW_LIMIT + 5; i++) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, watch_new, score) VALUES (?, ?, ?, 's', 'https://n.example/a', 1, ?)", [id24(), id, `Gym ${i}`, i])
  await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ?", [id])
  const r = await playNew(db, A, 'watch', w.id, 0)
  assert.deepEqual([r!.total, r!.items.length, r!.items[0].company], [NEW_LIMIT + 5, NEW_LIMIT, `Gym ${NEW_LIMIT + 4}`], 'highest scored first')
})

// ---- the page's pure pieces ----
const mem = (init: Record<string, string> = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } }

test('#1042 "last checked" read from browser storage fails closed to "never" on anything malformed', () => {
  const now = 1_800_000_000
  for (const bad of [null, undefined, '', 'abc', '-5', '1e9', '12.5', ' 5', '9'.repeat(13), {} as never, [] as never, 7 as never, String(now + 2 * DAY)]) assert.equal(parseSeen(bad, now), 0, JSON.stringify(bad))
  assert.equal(parseSeen(String(now - 60), now), now - 60)
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(readSeen(throwing, 'watch', 'x', now), 0, 'storage blocked: never checked, not a crash')
  assert.equal(writeSeen(throwing, 'watch', 'x', now), false)
  assert.equal(readSeen(null, 'watch', 'x', now), 0)
})

test('#1042 "Mark as seen" only moves forward and only to a real run time', () => {
  const s = mem()
  assert.equal(writeSeen(s, 'monitor', 'm1', 1_700_000_000), true)
  assert.equal(s.m.get(seenKey('monitor', 'm1')), '1700000000')
  assert.equal(writeSeen(s, 'monitor', 'm1', 1_600_000_000), false, 'a stale tab cannot move it back')
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(writeSeen(s, 'monitor', 'm1', bad), false)
  assert.equal(s.m.get(seenKey('monitor', 'm1')), '1700000000')
  // a corrupted or far-future stored marker (which reads as "never checked") does not block marking as seen
  const bad = mem({ [seenKey('watch', 'w1')]: '999999999999' })
  assert.equal(writeSeen(bad, 'watch', 'w1', 1_700_000_000), true)
  assert.equal(readSeen(bad, 'watch', 'w1'), 1_700_000_000)
  assert.notEqual(seenKey('watch', 'm1'), seenKey('monitor', 'm1'), 'kinds never share a marker')
})

test('#1042 labels and the Find leads now answers are plain sentences, never raw codes', () => {
  assert.deepEqual([newLabel(0, false), newLabel(0, true), newLabel(1, true), newLabel(4, false)], ['No new leads yet', 'Nothing new since you last checked', '1 new lead since you last checked', '4 new leads so far'])
  const T = Date.UTC(2026, 10, 12, 15) / 1000
  assert.deepEqual(runNowMessage(202, { job_id: 'j', next_run_at: T }, 'UTC'), { ok: true, text: 'Started. The new leads show here when this run finishes. Its next scheduled run moved to 12 Nov 2026, 15:00.' })
  assert.equal(runNowMessage(429, { error: 'too_soon', retry_at: T }, 'UTC').text, 'This play just ran. You can run it again after 12 Nov 2026, 15:00.')
  for (const e of ['paused', 'no_api_key', 'quota_exceeded', 'scan_active', 'not_found', 'too_many', 'limits_unavailable', 'weird']) {
    const m = runNowMessage(400, { error: e })
    assert.equal(m.ok, false); assert.ok(m.text.length > 10 && !/_/.test(m.text), m.text)
  }
  // a 202 without a job id, a job id with the wrong status, a network failure and a non-JSON body: never "Started"
  for (const [st, b] of [[202, null], [202, { error: 'x' }], [200, { job_id: 'j', next_run_at: T }], [0, null]] as const) assert.equal(runNowMessage(st, b as never).ok, false)
})

test('#1042 the play row shows last and next run to the minute, and an overdue live play as due now', () => {
  const T = Date.UTC(2026, 10, 12, 15, 30) / 1000
  const row = { id: 'c'.repeat(24), query: 'q', icp: null, interval_hours: 24, enabled: 1, paused_reason: null, last_run_at: T - DAY, next_run_at: T + 3600, last_new_count: 4, run_count: 1, last_job_id: null }
  const [p] = savedPlays(null, [row], 'UTC', T)
  assert.deepEqual([p.schedule, p.lastRun, p.nextRun], ['Daily', '11 Nov 2026, 15:30, 4 new', '12 Nov 2026, 16:30'])
  assert.equal(savedPlays(null, [{ ...row, next_run_at: T - 60 }], 'UTC', T)[0].nextRun, 'Due now: runs on the next scheduled check')
  assert.equal(savedPlays(null, [{ ...row, enabled: 0, next_run_at: T - 60 }], 'UTC', T)[0].nextRun, 'Paused: resume to schedule it')
})
