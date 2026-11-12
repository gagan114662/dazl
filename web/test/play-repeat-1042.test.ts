// #1042 (owner scope, Gagan via Quest 2026-11-11 11:48): a new account's first play repeats by itself (daily since
// the 2026-11-12 decision, test/play-daily-1042.test.ts), every run under the EXISTING caps, and an email lists the new leads after each run. Plus the review
// findings on PR #1050: one admission rule for the click and the scheduler, and "Mark as seen" never hides unseen leads.
// Both engines; synthetic accounts and rows only. No network, no provider, no paid call: runs only QUEUE jobs (nothing
// runs the scan pipeline) and mail goes to the outbox or a stubbed transport.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bothEngines } from './helpers/engines.ts'
import type { Db, Tx } from '../lib/db/client.ts'
import { createWatch, listWatches, runDueWatches, watchAction, type Fence } from '../lib/watch.ts'
import { createMonitor, runDueMonitors } from '../lib/monitors.ts'
import { FIRST_PLAY_WINDOW_S, REPEAT_INTERVAL_S, repeatFirstPlays, repeatIcp } from '../lib/play-repeat.ts'
import { MAIL_LIST_MAX, MAIL_WINDOW_S, composePlayRunMail, oneLine, sendPlayRunMails } from '../lib/play-mail.ts'
import { isFirstPlayRepeat, trialPauseReason } from '../lib/play-funding.ts'
import { NEW_LIMIT, playNew, runPlayNow, seenThrough } from '../lib/play-now.ts'
import { runEnded, runNowMessage } from '../lib/play-new-view.ts'
import { noteOf, savedPlays } from '../lib/saved-plays.ts'
import { setTransportForTests } from '../lib/system-mail.ts'
import { LeaseLost } from '../lib/shared/lease.ts'

const DAY = 86400
const NOW = Math.floor(Date.now() / 1000)
let n = 0
const id24 = () => (++n).toString(16).padStart(24, '0')
const uid = (c: string) => c.repeat(32)
const A = uid('a'), B = uid('b'), C = uid('c')
const ICP = JSON.stringify({ summary: 'Dental practices', who: ['Practice manager'], industries: ['Dental'], sizes: [], where: ['Leeds, UK'], signals: ['Hiring a practice manager'], exclude: [] })
const Q = 'Dental practices in Leeds hiring a practice manager'
// the full trial-scan configuration (fixture prices, not vendor prices): the existing caps, $0.30 / $1 / $10
const TRIAL_ENV: Record<string, string | undefined> = {
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002',
}
const NO_TRIAL: Record<string, string | undefined> = {}

// an account: a users row (verified email unless said otherwise), its personal workspace and a Google sign-in
async function account(db: Db, id: string, email: string, o: { verified?: boolean; google?: boolean } = {}) {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  if (o.verified !== false) await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [NOW - 10 * DAY, id])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, '', 'personal', ?, ?)", [id, id, NOW - 10 * DAY])
  if (o.google !== false) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
}
const giveKey = (db: Db, t: string) => db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [t])
type Lead = { company: string; domain?: string | null; signal?: string; score?: number; quarantined?: boolean }
// a scan of tenant t created at `at` and finished 5 minutes later with the given leads
async function scan(db: Db, t: string, at: number, o: { query?: string | null; icp?: string | null; status?: 'done' | 'failed'; leads?: Lead[]; watchId?: string; csv?: string } = {}) {
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, created_at, watch_id, csv_domain) VALUES (?, ?, 'x', '-', '-', ?, ?, 'running', ?, ?, ?)",
    [id, t, o.query === undefined ? Q : o.query, o.icp === undefined ? ICP : o.icp, at, o.watchId ?? null, o.csv ?? null])
  for (const l of o.leads ?? []) await db.run('INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url, score, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id24(), id, l.company, l.domain ?? null, l.signal ?? 'hiring a practice manager', 'https://n.example/a', l.score ?? 50, l.quarantined ? at : null])
  await db.run('UPDATE scan_jobs SET status = ?, finished_at = ? WHERE id = ?', [o.status ?? 'done', at + 300, id])
  return id
}
const watchesOf = (db: Db, t: string) => db.all<{ id: string; query: string; icp: string; active: number; next_run_at: number; last_run_at: number | null; run_budget: string | null; created_at: number }>('SELECT * FROM watches WHERE user_id = ? ORDER BY created_at, id', [t])
const jobsOf = (db: Db, t: string) => db.all<{ id: string; watch_id: string | null; status: string; funded_by: string | null; created_at: number }>('SELECT id, watch_id, status, funded_by, created_at FROM scan_jobs WHERE user_id = ? ORDER BY created_at, insert_seq', [t])
const outbox = (db: Db) => db.all<{ user_id: string; to_email: string; subject: string; body: string }>('SELECT user_id, to_email, subject, body FROM system_mail_outbox ORDER BY created_at, id')
const num = async (db: Db, sql: string, p: unknown[] = []) => Number((await db.get<{ n: number }>(sql, p as never))!.n)

// ---------------------------------------------------------------------------------------------------------------------
// (a) the first play repeats by itself; (b) weekly
// ---------------------------------------------------------------------------------------------------------------------

bothEngines('#1042 (a) a new account\'s first finished play gets ONE daily repeat, without anyone clicking anything', async ({ db }) => {
  await account(db, A, 'owner@acme-dental.example')
  const first = await scan(db, A, NOW - 3600, { leads: [{ company: 'Smile Leeds', domain: 'smile.example' }, { company: 'Bright Teeth' }] })
  // the gap on main: a first play is a one-off, nothing repeats it (no watch, no monitor), and the scheduler has nothing to run
  assert.deepEqual(await listWatches(db, A), [])
  assert.deepEqual(await runDueWatches(db, { now: NOW + 8 * DAY, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 0 })
  // the scheduler tick's first step
  const made = await repeatFirstPlays(db, { now: NOW })
  assert.equal(made.length, 1)
  const [w] = await watchesOf(db, A)
  assert.deepEqual([w.id, w.query, Number(w.active), Number(w.next_run_at), Number(w.last_run_at), Number(w.created_at)], [made[0], Q, 1, NOW - 3600 + 300 + REPEAT_INTERVAL_S, NOW - 3600, NOW], 'daily: first scheduled run one day after the play finished ("next search tomorrow")')
  assert.deepEqual(JSON.parse(w.icp).summary, 'Dental practices', 'the profile the run used')
  assert.equal((await db.get<{ watch_id: string }>('SELECT watch_id FROM scan_jobs WHERE id = ?', [first]))!.watch_id, w.id, 'the first play\'s job is linked: the once-only marker')
  // the first play's companies are remembered, so the next run marks only companies not shown before
  assert.deepEqual((await db.all<{ seen_key: string }>('SELECT seen_key FROM watch_seen WHERE watch_id = ? ORDER BY seen_key', [w.id])).map(r => r.seen_key), ['brightteeth', 'smile.example'])
  // what the Plays page lists: repeating, with a next-run time, as the automatic repeat
  const listed = await listWatches(db, A)
  assert.deepEqual(listed.map(x => [x.active, x.next_run_at, x.auto]), [[true, Number(w.next_run_at), true]])
  const [p] = savedPlays(listed as never, null, 'UTC', NOW, true)
  assert.equal(REPEAT_INTERVAL_S, DAY)
  assert.equal(p.schedule, 'Daily'); assert.equal(p.status.label, 'Live'); assert.match(p.nextRun, /\d{4}, \d\d:\d\d$/)
  assert.match(p.note ?? '', /search again every day/); assert.match(p.note ?? '', /email/)
  // idempotent across ticks and instances
  assert.deepEqual(await repeatFirstPlays(db, { now: NOW + 60 }), [])
  assert.equal((await watchesOf(db, A)).length, 1)
  assert.equal(await isFirstPlayRepeat(db, A, w.id), true)
})

bothEngines('#1042 (a) never re-created once the person deletes or pauses it, and never added beside a play they saved', async ({ db }) => {
  for (const [t, e] of [[A, 'a@a.example'], [B, 'b@b.example'], [C, 'c@c.example']] as const) await account(db, t, e)
  await scan(db, A, NOW - 3600)
  const [wa] = await repeatFirstPlays(db, { now: NOW })
  assert.equal(await watchAction(db, A, wa, 'delete'), true)
  assert.deepEqual(await repeatFirstPlays(db, { now: NOW + 60 }), [], 'deleted: stays deleted')
  // B saved a play by hand before the tick; C has a monitor: no automatic repeat for either
  await scan(db, B, NOW - 3600)
  await createWatch(db, B, 'Roofers in Ohio', '{"summary":"Roofers"}', null, NOW - 1800)
  await scan(db, C, NOW - 3600)
  const m = await createMonitor(db, C, { query: 'Accounting firms in Bristol' }, NOW - 1800)
  assert.ok('id' in m)
  assert.deepEqual(await repeatFirstPlays(db, { now: NOW + 120 }), [])
  assert.deepEqual((await watchesOf(db, B)).map(w => w.query), ['Roofers in Ohio'])
  assert.equal((await watchesOf(db, C)).length, 0)
  // a hand-made watch is never mistaken for the automatic repeat (no trial funding for it)
  assert.equal(await isFirstPlayRepeat(db, B, (await watchesOf(db, B))[0].id), false)
})

bothEngines('#1042 (a) which play is "first": the earliest DONE query scan; failed tries, CSV imports and old accounts do not count', async ({ db }) => {
  for (const [t, e] of [[A, 'a@a.example'], [B, 'b@b.example'], [C, 'c@c.example']] as const) await account(db, t, e)
  // A: the first try failed, a CSV import came next, the second search worked: the second search repeats
  await scan(db, A, NOW - 7200, { status: 'failed', query: 'failed first try' })
  await scan(db, A, NOW - 5400, { csv: 'acme.example', query: 'csv import' })
  const second = await scan(db, A, NOW - 3600, { query: 'Vets in Bath opening new clinics' })
  await scan(db, A, NOW - 1800, { query: 'a later search' })
  // B: an existing account whose first play finished before the window (deploy: existing accounts are not enrolled)
  await scan(db, B, NOW - FIRST_PLAY_WINDOW_S - 3600)
  await scan(db, B, NOW - 600, { query: 'a later search of B' })
  // C: a first play whose profile is unusable or whose request is too short gets no repeat (fails closed, nothing written)
  await scan(db, C, NOW - 3600, { icp: 'not json' })
  const made = await repeatFirstPlays(db, { now: NOW })
  assert.equal(made.length, 1)
  const [w] = await watchesOf(db, A)
  assert.equal(w.query, 'Vets in Bath opening new clinics')
  assert.equal((await jobsOf(db, A)).find(j => j.id === second)!.watch_id, w.id)
  assert.deepEqual([(await watchesOf(db, B)).length, (await watchesOf(db, C)).length], [0, 0])
  assert.equal(await num(db, 'SELECT count(*) AS n FROM scan_jobs WHERE watch_id IS NOT NULL'), 1, 'no other job was linked')
})

test('#1042 (a) the repeat\'s profile is parsed fail-closed: wrong types, junk and empty profiles give no repeat', () => {
  for (const bad of [null, '', 'not json', '[]', '"a string"', '42', 'true', 'null', '{"summary":', '\u0000']) assert.equal(repeatIcp(bad as never), null, JSON.stringify(bad))
  assert.equal(typeof repeatIcp(ICP), 'string')
  assert.equal(JSON.parse(repeatIcp(ICP)!).summary, 'Dental practices')
})

bothEngines('#1042 (a) a tick that lost its lease creates nothing; one account\'s failure does not block the others', async ({ db }) => {
  await account(db, A, 'a@a.example'); await account(db, B, 'b@b.example')
  await scan(db, A, NOW - 3600); await scan(db, B, NOW - 3000)
  const lost: Fence = function* () { throw new Error('lease lost') }
  // a plain error from the fence is recorded per account and skipped (the tick's own lease errors stop the pass: below)
  assert.deepEqual(await repeatFirstPlays(db, { now: NOW, fence: lost }), [])
  assert.equal(await num(db, 'SELECT count(*) AS n FROM watches'), 0)
  assert.equal(await num(db, 'SELECT count(*) AS n FROM scan_jobs WHERE watch_id IS NOT NULL'), 0)
  const { StaleLeaseWrite } = await import('../lib/shared/lease.ts')
  const stale: Fence = function* () { throw new StaleLeaseWrite('internal-tick', 1) }
  await assert.rejects(repeatFirstPlays(db, { now: NOW, fence: stale }), StaleLeaseWrite)
  assert.equal(await num(db, 'SELECT count(*) AS n FROM watches'), 0)
  // a fence that fails for the first account only: the other one still gets its repeat
  let failed = false
  const onlyFirst: Fence = function* () { if (!failed) { failed = true; throw new Error('boom for the first account') } }
  const made = await repeatFirstPlays(db, { now: NOW, fence: onlyFirst })
  assert.equal(made.length, 1)
  assert.equal((await repeatFirstPlays(db, { now: NOW + 60 })).length, 1, 'the account that failed is picked up next tick')
  assert.deepEqual([(await watchesOf(db, A)).length, (await watchesOf(db, B)).length], [1, 1])
})

// ---------------------------------------------------------------------------------------------------------------------
// every run under the existing caps: own key, or the free trial's existing admission for the first play's repeat only
// ---------------------------------------------------------------------------------------------------------------------

async function autoRepeat(db: Db, t: string, email: string, o: { google?: boolean } = {}) {
  await account(db, t, email, o)
  await scan(db, t, NOW - 3600)
  const [w] = await repeatFirstPlays(db, { now: NOW })
  return w
}
const due = NOW + 8 * DAY
const reservations = (db: Db, t: string) => db.all<{ job_id: string | null; reserve_usd: number }>('SELECT job_id, reserve_usd FROM trial_reservations WHERE tenant_id = ? ORDER BY created_at, id', [t])

bothEngines('#1042 keyless first-play repeat: its scheduled run is admitted by the EXISTING trial admission and marked as a trial scan', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a-dental.example')
  const r = await runDueWatches(db, { now: due, env: TRIAL_ENV })
  assert.deepEqual(r, { ran: 1, paused: 0, skipped: 0 })
  const job = (await jobsOf(db, A)).find(j => j.watch_id === w && j.created_at === due)!
  assert.equal(job.funded_by, 'trial', 'trial-marked, so the runner holds it to the per-scan reserve')
  assert.deepEqual((await reservations(db, A)).map(x => [x.job_id, Number(x.reserve_usd)]), [[job.id, 0.3]], 'one $0.30 reservation, linked to this job')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_scans WHERE tenant_id = ? AND job_id = ?', [A, job.id]), 1, 'counts as one of the free searches')
  assert.equal(Number((await watchesOf(db, A))[0].next_run_at), due + DAY, 'the repeat runs again a day later')
  assert.equal(JSON.parse((await db.get<{ run_budget: string }>('SELECT run_budget FROM scan_jobs WHERE id = ?', [job.id]))!.run_budget).max_usd, 0.3, 'free plan: held to $0.30')
})

bothEngines('#1042 with the trial off, or for a hand-made watch, a keyless run pauses exactly as before (never trial-funded)', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  assert.deepEqual(await runDueWatches(db, { now: due, env: NO_TRIAL }), { ran: 0, paused: 1, skipped: 0 })
  assert.deepEqual((await watchesOf(db, A)).map(x => [x.id, Number(x.active)]), [[w, 0]])
  assert.equal((await db.get<{ paused_reason: string }>('SELECT paused_reason FROM watches WHERE id = ?', [w]))!.paused_reason, 'no_api_key')
  await account(db, B, 'b@b.example')
  const hand = (await createWatch(db, B, 'Bakeries in Paris', '{"summary":"Bakeries"}', null, NOW - 8 * DAY)).watch!
  assert.deepEqual(await runDueWatches(db, { now: due, env: TRIAL_ENV }), { ran: 0, paused: 1, skipped: 0 })
  assert.equal((await db.get<{ paused_reason: string }>('SELECT paused_reason FROM watches WHERE id = ?', [hand.id]))!.paused_reason, 'no_api_key')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_reservations'), 0, 'nothing reserved')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM scan_jobs WHERE created_at = ?', [due]), 0)
  // the Plays page names the reason (it showed a bare "Paused" for no_api_key on main)
  const [p] = savedPlays((await listWatches(db, A)) as never, null, 'UTC', due)
  assert.equal(p.status.label, 'Paused: no AI key to run it')
})

bothEngines('#1042 the trial caps decide: 3 searches per account, then the repeat pauses as "free searches used up"; the day\'s ceiling only delays it', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  // two earlier trial searches of the account (the first play's own and one more): this run is the third and last
  for (let i = 0; i < 2; i++) await db.run('INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES (?, ?, NULL, 0.3, ?, ?)', [id24(), A, Math.floor((NOW - 2 * DAY) / 86400), NOW - 2 * DAY])
  assert.deepEqual(await runDueWatches(db, { now: due, env: TRIAL_ENV }), { ran: 1, paused: 0, skipped: 0 })
  // the next week: the account's 3 free searches are spent; the run pauses with a reason, nothing reserved, no job
  for (const j of (await jobsOf(db, A)).filter(x => x.status !== 'done')) { await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [j.id]); await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [due + 600, j.id]) }
  const before = await num(db, 'SELECT count(*) AS n FROM trial_reservations')
  assert.deepEqual(await runDueWatches(db, { now: due + 8 * DAY, env: TRIAL_ENV }), { ran: 0, paused: 1, skipped: 0 })
  assert.equal((await db.get<{ paused_reason: string }>('SELECT paused_reason FROM watches WHERE id = ?', [w]))!.paused_reason, 'trial_used')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_reservations'), before)
  const [p] = savedPlays((await listWatches(db, A)) as never, null, 'UTC', due + 8 * DAY)
  assert.match(p.status.label, /free searches are used up/)
  // B: the global daily ceiling is full: no run, no pause, the play stays due for a later tick
  const wb = await autoRepeat(db, B, 'b@b.example')
  for (let i = 0; i < 34; i++) await db.run('INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES (?, ?, NULL, 0.3, ?, ?)', [id24(), uid(String.fromCharCode(100 + (i % 5))) + i, Math.floor(due / 86400), due])
  assert.deepEqual(await runDueWatches(db, { now: due, env: TRIAL_ENV }), { ran: 0, paused: 0, skipped: 0 })
  const rb = (await watchesOf(db, B))[0]
  assert.deepEqual([rb.id, Number(rb.active)], [wb, 1])
  assert.equal((await reservations(db, B)).length, 0)
  assert.equal(trialPauseReason('global_daily_cap'), null)
  for (const r of ['not_configured', 'google_required', 'domain_used'] as const) assert.equal(trialPauseReason(r), 'no_api_key')
})

bothEngines('#1042 no Google sign-in (the trial needs one): the keyless repeat pauses; nothing is reserved', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example', { google: false })
  assert.deepEqual(await runDueWatches(db, { now: due, env: TRIAL_ENV }), { ran: 0, paused: 1, skipped: 0 })
  assert.equal((await db.get<{ paused_reason: string }>('SELECT paused_reason FROM watches WHERE id = ?', [w]))!.paused_reason, 'no_api_key')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_reservations'), 0)
})

bothEngines('#1042 a trial reservation for a run that did not happen is given back (lost race, scan already running, lost lease)', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  // the watch is run by someone else between the read and the write (its next_run_at moves inside the transaction)
  const race: Fence = function* (t: Tx) { yield* t.run('UPDATE watches SET next_run_at = next_run_at + 1 WHERE id = ?', [w]) }
  assert.deepEqual(await runDueWatches(db, { now: due, env: TRIAL_ENV, fence: race }), { ran: 0, paused: 0, skipped: 0 })
  assert.deepEqual(await reservations(db, A), [], 'released: no attempt or money held for a run that never existed')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_scans'), 0)
  // the fence throws (lease lost): the error propagates and the reservation is still released
  const lost: Fence = function* () { throw new LeaseLost('scheduler', 'fixture') }
  await assert.rejects(runDueWatches(db, { now: due, env: TRIAL_ENV, fence: lost }), LeaseLost)
  assert.deepEqual(await reservations(db, A), [])
  // a scan of the account is running: skipped before any reservation
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '-', '-', 'q', 'running', ?)", [id24(), A, NOW])
  assert.deepEqual(await runDueWatches(db, { now: due, env: TRIAL_ENV }), { ran: 0, paused: 0, skipped: 0 })
  assert.deepEqual(await reservations(db, A), [])
})

bothEngines('#1042 Find leads now on the keyless first-play repeat uses the same trial admission; a hand-made keyless watch is refused', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  const r = await runPlayNow(db, A, 'watch', w, NOW + 2 * 3600, TRIAL_ENV)
  assert.ok('job_id' in r, JSON.stringify(r))
  assert.equal(r.funded_by, 'trial')
  assert.deepEqual((await reservations(db, A)).map(x => x.job_id), [r.job_id])
  assert.equal(runNowMessage(202, r).text.startsWith('Started on your free searches.'), true)
  await account(db, B, 'b@b.example')
  const hand = (await createWatch(db, B, 'Bakeries in Paris', '{"summary":"Bakeries"}', null, NOW - DAY)).watch!
  assert.deepEqual(await runPlayNow(db, B, 'watch', hand.id, NOW, TRIAL_ENV), { error: 'no_api_key' })
  // trial off: refused, nothing reserved
  await account(db, C, 'c@c.example'); await scan(db, C, NOW - 3600); const [wc] = await repeatFirstPlays(db, { now: NOW })
  assert.deepEqual(await runPlayNow(db, C, 'watch', wc, NOW + 2 * 3600, NO_TRIAL), { error: 'no_api_key' })
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_reservations WHERE tenant_id IN (?, ?)', [B, C]), 0)
  // free searches used up: refused with its own answer
  for (let i = 0; i < 3; i++) await db.run('INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES (?, ?, NULL, 0.3, ?, ?)', [id24(), C, Math.floor(NOW / 86400), NOW])
  assert.deepEqual(await runPlayNow(db, C, 'watch', wc, NOW + 2 * 3600, TRIAL_ENV), { error: 'trial_used' })
  assert.match(runNowMessage(402, { error: 'trial_used' }).text, /free searches are used up/)
})

bothEngines('#1042 one admission rule: a click and the scheduler never both queue a scan for the account (lock + re-check inside the write)', async ({ db }) => {
  await account(db, A, 'a@a.example'); await giveKey(db, A)
  const w1 = (await createWatch(db, A, 'Roofers in Ohio', '{"summary":"Roofers"}', null, NOW - 8 * DAY)).watch!
  const w2 = (await createWatch(db, A, 'Bakeries in Paris', '{"summary":"Bakeries"}', null, NOW - 8 * DAY)).watch!
  // a click on one play and the tick for both, at once: exactly one scan for the account
  const [click, tick] = await Promise.all([runPlayNow(db, A, 'watch', w1.id, NOW), runDueWatches(db, { now: NOW, env: NO_TRIAL })])
  const active = (await jobsOf(db, A)).filter(j => j.status === 'pending')
  assert.equal(active.length, 1, `one scan: click ${JSON.stringify(click)}, tick ${JSON.stringify(tick)}`)
  // a monitor keeps its existing rule (beside one active scan, never beside two), now checked inside the same lock
  const m1 = await createMonitor(db, A, { query: 'Accounting firms in Bristol' }, NOW - DAY)
  assert.ok('id' in m1)
  const ran = await runDueMonitors(db, { now: NOW })
  assert.equal(ran.length, 1, 'beside one')
  await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [NOW, m1.id])
  assert.deepEqual(await runDueMonitors(db, { now: NOW }), [], 'never beside two')
  void w2
})

bothEngines('#1042 the scheduler re-checks active scans INSIDE its write: a scan admitted after its first check (a click) blocks it', async ({ db }) => {
  await account(db, A, 'a@a.example'); await giveKey(db, A)
  const w = (await createWatch(db, A, 'Roofers in Ohio', '{"summary":"Roofers"}', null, NOW - 8 * DAY)).watch!
  // between the tick's first check and its write, a "Find leads now" commits a scan for the account (simulated in the
  // fence, which runs first inside the tick's transaction)
  const clicked = id24()
  const click: Fence = function* (t: Tx) { yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '-', '-', 'q', 'pending', ?)", [clicked, A, NOW]) }
  assert.deepEqual(await runDueWatches(db, { now: NOW, env: NO_TRIAL, fence: click }), { ran: 0, paused: 0, skipped: 0 })
  assert.deepEqual((await jobsOf(db, A)).map(j => j.id), [clicked], 'one scan for the account, never two')
  assert.equal(Number((await watchesOf(db, A))[0].next_run_at), Number(w.next_run_at), 'still due: the next tick runs it')
})

bothEngines('#1042 (c) two ticks (or instances) mailing at the same time send ONE email per run', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  await watchRun(db, A, w, R, [{ company: 'Smile Leeds' }])
  const sent: unknown[] = []
  setTransportForTests(async m => { sent.push(m) })
  try {
    const env = { SYSTEM_MAIL_SMTP_URL: 'smtp://fixture.invalid', SYSTEM_MAIL_FROM: 'dazl <no-reply@dazl.example>' }
    const counts = await Promise.all([sendPlayRunMails(db, { now: S, env }), sendPlayRunMails(db, { now: S, env }), sendPlayRunMails(db, { now: S, env })])
    assert.equal(sent.length, 1, `one email (ticks reported ${JSON.stringify(counts)})`)
  } finally { setTransportForTests(null) }
})

// ---------------------------------------------------------------------------------------------------------------------
// (c) the email after each run that found new leads
// ---------------------------------------------------------------------------------------------------------------------

// a finished run of watch w (created after the watch) with leads; returns the job id. R: when the mailed runs start
// (after their play was saved), S: the tick that mails them
const R = NOW + DAY, S = R + 3600
async function watchRun(db: Db, t: string, w: string, at: number, leads: Lead[], o: { enrichRunning?: boolean } = {}) {
  const id = await scan(db, t, at, { watchId: w, leads })
  await db.run('UPDATE leads SET watch_new = 1 WHERE scan_job_id = ?', [id])
  if (o.enrichRunning) await db.run('UPDATE scan_jobs SET enrich_started_at = ?, enrich_finished_at = NULL WHERE id = ?', [at + 300, id])
  return id
}

bothEngines('#1042 (c) after a run that found new leads: ONE email to the account listing them, with a link; never twice', async ({ db }) => {
  const w = await autoRepeat(db, A, 'owner@acme-dental.example')
  const job = await watchRun(db, A, w, R, [{ company: 'Smile Leeds', signal: 'hiring a practice manager', score: 90 }, { company: 'Bright Teeth', signal: 'opening a second site', score: 80 }, { company: 'Hidden Co', quarantined: true }])
  // the gap on main: nothing ever mailed the account about a repeat's new leads
  assert.deepEqual(await outbox(db), [])
  assert.equal(await sendPlayRunMails(db, { now: S, env: { PUBLIC_BASE_URL: 'https://dazl.example' } }), 1)
  const [m] = await outbox(db)
  assert.deepEqual([m.user_id, m.to_email], [A, 'owner@acme-dental.example'])
  assert.match(m.subject, /^2 new leads from your play "/)
  assert.match(m.body, /found 2 new leads/)
  assert.match(m.body, /- Smile Leeds: hiring a practice manager\n- Bright Teeth: opening a second site/)
  assert.ok(!m.body.includes('Hidden Co'), 'a quarantined lead is not listed, as in Leads')
  assert.match(m.body, new RegExp(`https://dazl\\.example/app/leads\\?job_id=${job}`))
  assert.match(m.body, /pause it on the Plays page/)
  assert.match(m.body, /Nothing was sent to anyone on your behalf/)
  // the same tick again, or another instance: no second email
  assert.equal(await sendPlayRunMails(db, { now: S + 60 }), 0)
  assert.equal((await outbox(db)).length, 1)
  // the first play's own run (older than its repeat) never mails
  assert.equal(await num(db, "SELECT count(*) AS n FROM watch_seen WHERE seen_key LIKE 'mail:%'"), 1)
})

bothEngines('#1042 (c) no email: nothing new, a paused or deleted play, an unverified address, an old run; an unfinished enrichment waits', async ({ db }) => {
  const wa = await autoRepeat(db, A, 'a@a.example')
  await watchRun(db, A, wa, R, []) // no new leads
  const wb = await autoRepeat(db, B, 'b@b.example')
  await watchRun(db, B, wb, R, [{ company: 'Paused Co' }])
  await watchAction(db, B, wb, 'pause')
  await account(db, C, 'c@c.example', { verified: false }); await scan(db, C, NOW - 3600); const [wc] = await repeatFirstPlays(db, { now: NOW })
  await watchRun(db, C, wc, R, [{ company: 'Unverified Co' }])
  const D = uid('d'); await account(db, D, 'd@d.example'); const wd = (await createWatch(db, D, 'Old play', '{"summary":"s"}', null, NOW - 10 * DAY)).watch!.id
  await watchRun(db, D, wd, NOW - MAIL_WINDOW_S - 3600, [{ company: 'Old Co' }]) // finished before the window
  const E = uid('e'); const we = await autoRepeat(db, E, 'e@e.example')
  const late = await watchRun(db, E, we, S - 120, [{ company: 'Enriching Co' }], { enrichRunning: true })
  assert.equal(await sendPlayRunMails(db, { now: S }), 0)
  assert.deepEqual(await outbox(db), [])
  // pausing stops the email for good for that run (claimed once, never sent): resuming does not send it late
  await watchAction(db, B, wb, 'resume', NOW)
  assert.equal(await sendPlayRunMails(db, { now: S + 60 }), 0)
  // the enriching run is mailed once its enrichment ends
  await db.run('UPDATE scan_jobs SET enrich_finished_at = ? WHERE id = ?', [S + 30, late])
  assert.equal(await sendPlayRunMails(db, { now: S + 90 }), 1)
  assert.deepEqual((await outbox(db)).map(m => [m.user_id, m.to_email]), [[E, 'e@e.example']])
})

bothEngines('#1042 (c) delivery: the SMTP transport is called once with a header-safe subject; a failing send is recorded and never retried', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  await db.run('UPDATE watches SET query = ? WHERE id = ?', ['Dentists\r\nBcc: victim@evil.example in Leeds', w])
  await watchRun(db, A, w, R, [{ company: 'Evil\r\nBcc: x@evil.example Co', signal: 'line1\nline2' }])
  const sent: { to: string; subject: string; text: string }[] = []
  setTransportForTests(async m => { sent.push(m) })
  try {
    const env = { SYSTEM_MAIL_SMTP_URL: 'smtp://fixture.invalid', SYSTEM_MAIL_FROM: 'dazl <no-reply@dazl.example>' }
    assert.equal(await sendPlayRunMails(db, { now: S, env }), 1)
    assert.equal(sent.length, 1)
    assert.ok(!/[\r\n]/.test(sent[0].subject), sent[0].subject)
    assert.ok(!sent[0].text.includes('\r'), 'no carriage returns from data')
    assert.match(sent[0].text, /- Evil Bcc: x@evil\.example Co: line1 line2/)
    // B: the transport throws; the run stays claimed (at most once) and the next tick does not resend
    const wb = await autoRepeat(db, B, 'b@b.example')
    await watchRun(db, B, wb, R, [{ company: 'Fail Co' }])
    setTransportForTests(async () => { throw new Error('smtp down') })
    assert.equal(await sendPlayRunMails(db, { now: S, env }), 0)
    setTransportForTests(async m => { sent.push(m) })
    assert.equal(await sendPlayRunMails(db, { now: S + 60, env }), 0)
    assert.equal(sent.length, 1)
  } finally { setTransportForTests(null) }
})

bothEngines('#1042 (c) a lost lease claims nothing and sends nothing', async ({ db }) => {
  const w = await autoRepeat(db, A, 'a@a.example')
  await watchRun(db, A, w, R, [{ company: 'Smile Leeds' }])
  const { StaleLeaseWrite } = await import('../lib/shared/lease.ts')
  const stale: Fence = function* () { throw new StaleLeaseWrite('internal-tick', 1) }
  await assert.rejects(sendPlayRunMails(db, { now: S, fence: stale }), StaleLeaseWrite)
  assert.equal(await num(db, "SELECT count(*) AS n FROM watch_seen WHERE seen_key LIKE 'mail:%'"), 0)
  assert.deepEqual(await outbox(db), [])
  assert.equal(await sendPlayRunMails(db, { now: S }), 1, 'the next tick that holds the lease sends it')
})

test('#1042 (c) the email text: at most MAIL_LIST_MAX lines plus "and N more", junk values made safe, never a raw value', () => {
  const leads = Array.from({ length: 13 }, (_, i) => ({ company: `Co ${i}`, signal: `s${i}` }))
  const m = composePlayRunMail({ userId: A, to: 'a@a.example', jobId: 'f'.repeat(24), query: Q, icp: ICP, total: 13, leads, base: 'https://dazl.ai/' })
  assert.equal((m.text.match(/^- /gm) ?? []).length, MAIL_LIST_MAX)
  assert.match(m.text, /\.\.\.and 3 more\./)
  assert.match(m.text, /https:\/\/dazl\.ai\/app\/leads\?job_id=f{24}/)
  assert.equal(m.subject, `13 new leads from your play "${m.subject.split('"')[1]}"`)
  const one = composePlayRunMail({ userId: A, to: 'a@a.example', jobId: 'f'.repeat(24), query: '', icp: '[1,2]', total: 1, leads: [{ company: null, signal: 42 }], base: 'https://dazl.ai' })
  assert.match(one.subject, /^1 new lead from your play "/)
  assert.match(one.text, /- A company: 42/)
  for (const [v, want] of [[null, ''], [undefined, ''], [12, '12'], ['a\u0000b\u202Fc', 'a b c'], ['\ud800x', '\ufffdx'], ['x'.repeat(500), 'x'.repeat(19) + '…']] as const) assert.equal(oneLine(v, 20), want, JSON.stringify(v))
})

// ---------------------------------------------------------------------------------------------------------------------
// review findings: what's new is one snapshot, and "Mark as seen" never hides leads that were not shown
// ---------------------------------------------------------------------------------------------------------------------

bothEngines('#1042 two tenants: the repeat and the email each stay inside their own tenant', async ({ db }) => {
  await account(db, A, 'a@a.example'); await account(db, B, 'b@b.example')
  const ja = await scan(db, A, NOW - 3600, { query: 'A secret play for dentists', leads: [{ company: 'A Only Co', domain: 'a-only.example' }] })
  const jb = await scan(db, B, NOW - 3000, { query: 'B secret play for roofers', leads: [{ company: 'B Only Co', domain: 'b-only.example' }] })
  const made = await repeatFirstPlays(db, { now: NOW })
  assert.equal(made.length, 2)
  const [wa] = await watchesOf(db, A), [wb] = await watchesOf(db, B)
  assert.deepEqual([wa.query, wb.query], ['A secret play for dentists', 'B secret play for roofers'])
  assert.deepEqual((await jobsOf(db, A)).map(j => [j.id, j.watch_id]), [[ja, wa.id]])
  assert.deepEqual((await jobsOf(db, B)).map(j => [j.id, j.watch_id]), [[jb, wb.id]])
  assert.deepEqual((await db.all<{ seen_key: string }>('SELECT seen_key FROM watch_seen WHERE watch_id = ?', [wa.id])).map(r => r.seen_key), ['a-only.example'], 'only A\'s companies in A\'s memory')
  // another tenant's play id is never A's: not first-play, nothing listed
  assert.equal(await isFirstPlayRepeat(db, A, wb.id), false)
  assert.equal(await playNew(db, A, 'watch', wb.id, 0), null)
  // each run's email goes to its own account and lists only its own leads
  await watchRun(db, A, wa.id, R, [{ company: 'A New Co' }])
  await watchRun(db, B, wb.id, R, [{ company: 'B New Co' }])
  assert.equal(await sendPlayRunMails(db, { now: S }), 2)
  const mails = await outbox(db)
  const ma = mails.find(m => m.user_id === A)!, mb = mails.find(m => m.user_id === B)!
  assert.deepEqual([ma.to_email, mb.to_email], ['a@a.example', 'b@b.example'])
  assert.ok(ma.body.includes('A New Co') && !ma.body.includes('B New Co') && !ma.body.includes('B secret'))
  assert.ok(mb.body.includes('B New Co') && !mb.body.includes('A New Co') && !mb.body.includes('A secret'))
})

bothEngines('#1042 what\'s new cut at NEW_LIMIT: "Mark as seen" covers only whole runs shown, so nothing unseen is hidden', async ({ db }) => {
  const w = (await createWatch(db, A, 'Gyms in Austin', '{"summary":"s"}', null, NOW - 30 * DAY)).watch!
  const lead = (i: number, tag: string) => ({ company: `${tag} ${i}`, score: i })
  const r1 = await watchRun(db, A, w.id, NOW - 3 * DAY, Array.from({ length: 30 }, (_, i) => lead(i, 'Old')))
  const r2 = await watchRun(db, A, w.id, NOW - 2 * DAY, Array.from({ length: 30 }, (_, i) => lead(i, 'New')))
  const page = (await playNew(db, A, 'watch', w.id, 0, NOW))!
  assert.deepEqual([page.total, page.items.length, page.truncated], [60, NEW_LIMIT, true])
  // the page holds all of run 1 and part of run 2: it may be marked seen through run 1 only
  assert.equal(page.seen_through, NOW - 3 * DAY + 300)
  assert.equal(page.items[0].job_id, r2, 'display: newest first')
  // the bug on the first head: "Mark as seen" stored the newest run's time and the 10 unlisted leads of run 2 vanished
  const old = (await playNew(db, A, 'watch', w.id, page.latest_at!, NOW))!
  assert.equal(old.total, 0, 'marking at latest_at (the old behaviour) hides leads that were never shown')
  const next = (await playNew(db, A, 'watch', w.id, page.seen_through!, NOW))!
  assert.deepEqual([next.total, next.truncated, new Set(next.items.map(i => i.job_id)).size, next.items[0].job_id], [30, false, 1, r2], 'marking at seen_through shows ALL of run 2 next')
  void r1
  // one run alone bigger than the page: nothing can be marked (the page says to open it in Leads)
  const w2 = (await createWatch(db, B, 'Gyms in Dallas', '{"summary":"s"}', null, NOW - 30 * DAY)).watch!
  await watchRun(db, B, w2.id, NOW - DAY, Array.from({ length: NEW_LIMIT + 5 }, (_, i) => lead(i, 'Gym')))
  const big = (await playNew(db, B, 'watch', w2.id, 0, NOW))!
  assert.deepEqual([big.total, big.items.length, big.seen_through, big.items[0].company], [NEW_LIMIT + 5, NEW_LIMIT, null, `Gym ${NEW_LIMIT + 4}`])
})

bothEngines('#1042 what\'s new counts a run from when it FINISHED: a run that started earlier but finished later is not lost', async ({ db }) => {
  const w = (await createWatch(db, A, 'Vets in Bath', '{"summary":"s"}', null, NOW - 30 * DAY)).watch!
  const early = await watchRun(db, A, w.id, NOW - 3 * DAY, [{ company: 'Early Co' }])
  // started before the marker below, finished after it
  await db.run('UPDATE scan_jobs SET finished_at = ? WHERE id = ?', [NOW - DAY, early])
  const marker = NOW - 2 * DAY
  const r = (await playNew(db, A, 'watch', w.id, marker, NOW))!
  assert.deepEqual(r.items.map(i => i.company), ['Early Co'])
})

test('#1042 seenThrough: only whole time groups, never at or after now, never 0', () => {
  assert.equal(seenThrough([], false, 100), null)
  assert.equal(seenThrough([10, 10, 20], false, 100), 20)
  assert.equal(seenThrough([10, 10, 20, 20], true, 100), 10)
  assert.equal(seenThrough([20, 20], true, 100), null)
  assert.equal(seenThrough([50, 100], false, 100), 99, 'an item visible this second is shown again, not lost')
  assert.equal(seenThrough([0], false, 100), null)
})

test('#1042 following a started run: ends on done, failed or gone; anything else keeps polling', () => {
  assert.equal(runEnded(200, { status: 'done' }), true)
  assert.equal(runEnded(200, { status: 'failed' }), true)
  assert.equal(runEnded(404, null), true)
  for (const [s, b] of [[200, { status: 'running' }], [200, { status: 'enriching' }], [200, { status: 'pending' }], [200, null], [500, { status: 'done' }], [200, 'done'], [200, { status: ['done'] }], [0, null]] as const) assert.equal(runEnded(s, b), s === 500 ? true : false, JSON.stringify([s, b]))
})

test('#1042 the play note never promises an email the host cannot send', () => {
  assert.equal(noteOf(false, false), null)
  assert.match(noteOf(true, false)!, /search again every day/); assert.doesNotMatch(noteOf(true, false)!, /email/)
  assert.match(noteOf(false, true)!, /email/)
  assert.equal(savedPlays([{ id: 'x', query: 'q', icp: null, active: true, next_run_at: NOW + DAY, last_run_at: null, paused_reason: null, last_job_id: null, last_status: null, new_leads: 0 }], null, 'UTC', NOW)[0].note, null)
})
