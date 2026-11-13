// #1042 decision (Hermes, delegated by Gagan, 2026-11-12): "Daily, not weekly. The first play keeps finding new leads every
// day, on every plan including free, with a hard per-tenant cap: free plan 1 scan/day, at most $0.30, counted against the
// existing trial/spend caps; paid plans follow their quota. If the cap is hit, skip that day and say so on Home."
// Both engines; synthetic accounts and rows only. No network, no provider, no paid call: runs only QUEUE jobs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bothEngines } from './helpers/engines.ts'
import type { Db, Tx } from '../lib/db/client.ts'
import { createWatch, listWatches, pullInWeeklyRepeats, runDueWatches, watchAction, type Fence } from '../lib/watch.ts'
import { firstRepeatAt, repeatFirstPlays, REPEAT_INTERVAL_S } from '../lib/play-repeat.ts'
import { runPlayNow } from '../lib/play-now.ts'
import { runNowMessage } from '../lib/play-new-view.ts'
import { savedPlays } from '../lib/saved-plays.ts'
import { playPace, skipNoticeLine } from '../lib/play-card.ts'
import { composePlayRunMail, sendPlayRunMails } from '../lib/play-mail.ts'
import { savePlan } from '../lib/plans.ts'
import { cappedRunBudget, DAY_S, FREE_RUN_MAX_USD, nextDayRun, PLAY_SKIPPED, utcDayStart, WEEK_S } from '../lib/play-cadence.ts'
import { LeaseLost } from '../lib/shared/lease.ts'

const DAY = 86400, H = 3600
// fixed clock: the first play is created at 15:00 UTC on day D0 and finishes 5 minutes later
const D0 = utcDayStart(Math.floor(Date.now() / 1000)) - 5 * DAY
const T0 = D0 + 15 * H
const FIN = T0 + 300
let n = 0
const id24 = () => (++n).toString(16).padStart(24, '0')
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const ICP = JSON.stringify({ summary: 'Dental practices', who: ['Practice manager'], industries: ['Dental'], sizes: [], where: ['Leeds, UK'], signals: ['Hiring a practice manager'], exclude: [] })
const Q = 'Dental practices in Leeds hiring a practice manager'
const TRIAL_ENV: Record<string, string | undefined> = {
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002',
}
const NO_TRIAL: Record<string, string | undefined> = {}

async function account(db: Db, id: string, email: string) {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [D0 - 10 * DAY, id])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, '', 'personal', ?, ?)", [id, id, D0 - 10 * DAY])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
}
const giveKey = (db: Db, t: string) => db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [t])
// a scan of tenant t created at `at`, finished 5 minutes later
async function scan(db: Db, t: string, at: number, o: { status?: 'done' | 'failed'; error?: string | null; watchId?: string; company?: string; query?: string } = {}) {
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, created_at, watch_id) VALUES (?, ?, 'x', '-', '-', ?, ?, 'running', ?, ?)", [id, t, o.query ?? Q, ICP, at, o.watchId ?? null])
  if (o.company) await db.run("INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url, score, watch_new) VALUES (?, ?, ?, NULL, 'hiring', 'https://n.example/a', 50, 1)", [id24(), id, o.company])
  await db.run('UPDATE scan_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?', [o.status ?? 'done', o.error ?? null, at + 300, id])
  return id
}
// a new account whose first play finished at FIN, and the daily repeat the tick creates for it
async function firstPlay(db: Db, t: string, email: string, o: { key?: boolean } = {}) {
  await account(db, t, email)
  if (o.key !== false) await giveKey(db, t)
  await scan(db, t, T0)
  const [w] = await repeatFirstPlays(db, { now: FIN + 60 })
  return w
}
const watch = (db: Db, id: string) => db.get<{ next_run_at: number; last_run_at: number | null; active: number }>('SELECT next_run_at, last_run_at, active FROM watches WHERE id = ?', [id])
const jobsAt = (db: Db, t: string, at: number) => db.all<{ id: string; run_budget: string | null; funded_by: string | null }>('SELECT id, run_budget, funded_by FROM scan_jobs WHERE user_id = ? AND created_at = ?', [t, at])
const skips = (db: Db, t: string) => db.all<{ resource_id: string; at: number; summary: string; actor_kind: string }>('SELECT resource_id, at, summary, actor_kind FROM audit_events WHERE tenant_id = ? AND action = ? ORDER BY at, seq', [t, PLAY_SKIPPED])
// a queued run finishes (pending -> running -> done, the only legal path)
async function finishJob(db: Db, id: string, at: number) {
  await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [id])
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [at, id])
}
const num = async (db: Db, sql: string, p: unknown[] = []) => Number((await db.get<{ n: number }>(sql, p as never))!.n)

bothEngines('#1042 daily: the first play\'s repeat says "next search tomorrow" and runs every day; a hand-made watch stays weekly', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  // the gap on main: the repeat's first run was a WEEK after the first play
  assert.equal(REPEAT_INTERVAL_S, DAY)
  const due1 = FIN + DAY
  assert.equal(Number((await watch(db, w))!.next_run_at), due1, 'first repeat: tomorrow, at the time the first play finished')
  const [row] = await listWatches(db, A)
  assert.deepEqual([row.auto, row.interval_s, row.skipped], [true, DAY, null])
  const [p] = savedPlays([row] as never, null, 'UTC', FIN + 120)
  assert.equal(p.schedule, 'Daily')
  assert.match(p.note ?? '', /search again every day/)
  assert.match(playPace({ status: 'done', error: null, created_at: T0, query: Q }, [row]).pace, /^Runs every day, next /)
  assert.equal(skipNoticeLine([row]), null, 'nothing skipped: no Home notice')
  // three consecutive days, each a run one day after the last (keyed, free plan: one scan a day)
  for (const d of [0, 1, 2]) {
    const at = due1 + d * DAY
    assert.deepEqual(await runDueWatches(db, { now: at, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 }, `day ${d + 1}`)
    assert.equal(Number((await watch(db, w))!.next_run_at), at + DAY)
    for (const j of await jobsAt(db, A, at)) await finishJob(db, j.id, at + 300)
  }
  // pausing stops it; resuming schedules the next run a day out (a week on main)
  assert.equal(await watchAction(db, A, w, 'pause'), true)
  assert.deepEqual(await runDueWatches(db, { now: due1 + 10 * DAY, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 0 })
  assert.equal(await watchAction(db, A, w, 'resume', due1 + 10 * DAY), true)
  assert.equal(Number((await watch(db, w))!.next_run_at), due1 + 11 * DAY)
  // a watch made by hand ("Watch this weekly") is unchanged: weekly on create, run and resume (A paused: this part
  // goes back in time)
  await watchAction(db, A, w, 'pause')
  await account(db, B, 'b@b.example'); await giveKey(db, B)
  const hand = (await createWatch(db, B, 'Roofers in Ohio', '{"summary":"Roofers"}', null, D0)).watch!
  assert.equal(Number(hand.next_run_at), D0 + WEEK_S)
  assert.deepEqual(await runDueWatches(db, { now: D0 + WEEK_S, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal(Number((await watch(db, hand.id))!.next_run_at), D0 + 2 * WEEK_S)
  assert.equal((await jobsAt(db, B, D0 + WEEK_S))[0].run_budget, null, 'a hand-made watch carries no added budget')
  const [hp] = savedPlays((await listWatches(db, B)) as never, null, 'UTC', D0 + WEEK_S)
  assert.equal(hp.schedule, 'Weekly')
})

bothEngines('#1042 free plan: a scan already started today skips that day\'s run (same time tomorrow), and Plays and Home say so until it runs', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  const due1 = FIN + DAY
  // another account's scan today is not this account's (the cap is per account)
  await account(db, B, 'b@b.example'); await scan(db, B, utcDayStart(due1) + H)
  // a search the person ran in Leads this morning (a different request) is today's one scan
  const other = await scan(db, A, utcDayStart(due1) + 8 * H, { query: 'Roofers in Ohio' })
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 1 })
  assert.deepEqual(await jobsAt(db, A, due1), [], 'no scan queued')
  assert.deepEqual([Number((await watch(db, w))!.next_run_at), (await watch(db, w))!.active], [due1 + DAY, 1], 'still live; moved to the same time tomorrow')
  const [ev] = await skips(db, A)
  assert.deepEqual([ev.resource_id, Number(ev.at), ev.actor_kind, JSON.parse(ev.summary)], [w, due1, 'service', { reason: 'free_daily_cap', due_at: due1, next_run_at: due1 + DAY, daily_runs: 1 }])
  // the next tick that day: not due any more, nothing more written
  assert.deepEqual(await runDueWatches(db, { now: due1 + 600, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 0 })
  assert.equal((await skips(db, A)).length, 1)
  // Plays and Home say why
  const [row] = await listWatches(db, A)
  assert.deepEqual(row.skipped, { at: due1, reason: 'free_daily_cap', next_run_at: due1 + DAY })
  const dueDay = new Date(due1 * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const [p] = savedPlays([row] as never, null, 'UTC', due1 + 600)
  assert.match(p.note ?? '', new RegExp(`^The search due ${dueDay} \\d{4} was skipped: the free plan runs 1 search a day and another search had already run that day\\. Next search `))
  assert.match(playPace({ status: 'done', error: null, created_at: T0, query: Q }, [row]).pace, /^Runs every day, next /, 'the skip is said once, in the Home notice below')
  // Home's play card shows the NEWEST search (the Roofers one), whose query matches no play: the notice is still on Home,
  // and it names the day, so it stays true the next morning
  assert.equal(playPace({ status: 'done', error: null, created_at: utcDayStart(due1) + 8 * H, query: 'Roofers in Ohio' }, [row]).pace.includes('skipped'), false)
  assert.match(skipNoticeLine([row], 'UTC') ?? '', new RegExp(`^Your daily play ".+" skipped its search due ${dueDay}: the free plan runs 1 search a day and another search had already run that day\\. Next search `))
  assert.ok(other)
  // the next day it runs on the account's own key, with the play's own budget (none: Autopilot and research are not
  // turned off for it), and the notice goes away
  const due2 = due1 + DAY
  assert.deepEqual(await runDueWatches(db, { now: due2, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  const [job] = await jobsAt(db, A, due2)
  assert.equal(job.run_budget, null)
  assert.equal((await listWatches(db, A))[0].skipped, null)
  // a paused play shows no skip line
  await scan(db, A, utcDayStart(due2 + DAY) + H)
  await finishJob(db, job.id, due2 + 300)
  assert.deepEqual(await runDueWatches(db, { now: due2 + DAY, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 1 })
  await watchAction(db, A, w, 'pause')
  assert.equal((await listWatches(db, A))[0].skipped, null)
})

bothEngines('#1042 free plan, no key of its own: a capped day reserves nothing from the free trial', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example', { key: false })
  const due1 = FIN + DAY
  await scan(db, A, utcDayStart(due1) + H)
  assert.deepEqual(await runDueWatches(db, { now: due1, env: TRIAL_ENV }), { ran: 0, paused: 0, skipped: 1 })
  assert.equal(await num(db, 'SELECT count(*) AS n FROM trial_reservations WHERE tenant_id = ?', [A]), 0)
  // next day: a trial run, its reserve $0.30 and its own budget $0.30
  assert.deepEqual(await runDueWatches(db, { now: due1 + DAY, env: TRIAL_ENV }), { ran: 1, paused: 0, skipped: 0 })
  const [job] = await jobsAt(db, A, due1 + DAY)
  assert.equal(job.funded_by, 'trial')
  assert.deepEqual(JSON.parse(job.run_budget!), { max_usd: FREE_RUN_MAX_USD }, "dazl's money: held to $0.30")
  // Find leads now on the free trial carries it too (a later day, no scan yet that day)
  await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [job.id]); await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [due1 + DAY + 300, job.id])
  const click = utcDayStart(due1 + 2 * DAY) + 2 * H
  const r = await runPlayNow(db, A, 'watch', w, click, TRIAL_ENV)
  assert.ok('job_id' in r && r.funded_by === 'trial', JSON.stringify(r))
  assert.deepEqual(JSON.parse((await jobsAt(db, A, click))[0].run_budget!), { max_usd: FREE_RUN_MAX_USD })
  assert.equal(Number((await watch(db, w))!.next_run_at), click + DAY)
})

bothEngines('#1042 the daily cap is re-checked inside the run\'s transaction: a scan started after the first check skips the day', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  const due1 = FIN + DAY
  // the fence runs first in each of the tick's transactions (1: the weekly pull-in, 2: the cap pre-check, 3: the job's):
  // the job's transaction sees a scan a click started after the pre-check passed
  let calls = 0
  const click: Fence = function* (t: Tx) { if (++calls === 3) yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '-', '-', 'q', 'done', ?)", [id24(), A, due1 - 60]) }
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL, fence: click }), { ran: 0, paused: 0, skipped: 1 })
  assert.deepEqual(await jobsAt(db, A, due1), [])
  assert.equal(Number((await watch(db, w))!.next_run_at), due1 + DAY)
})

bothEngines('#1042 the free daily cap is hard: a failed run that day still uses it (no second run the same day)', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  const due1 = FIN + DAY
  await scan(db, A, utcDayStart(due1) + 2 * H, { status: 'failed', error: 'no_candidates' })
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 1 })
  const click = due1 + 2 * H
  assert.deepEqual(await runPlayNow(db, A, 'watch', w, click, NO_TRIAL), { error: 'daily_cap', retry_at: utcDayStart(click) + DAY })
})

bothEngines('#1042 one account\'s failed skip write never stops the other accounts\' runs', async ({ db }) => {
  const wa = await firstPlay(db, A, 'a@a.example')
  await account(db, B, 'b@b.example'); await giveKey(db, B); await scan(db, B, T0 + 60)
  const [wb] = await repeatFirstPlays(db, { now: FIN + 120 })
  const due = FIN + 60 + DAY // both due; A first
  await scan(db, A, utcDayStart(due) + H)
  let calls = 0
  // the first transaction of a pass is the weekly pull-in (lib/watch.ts pullInWeeklyRepeats); count from the next one
  const flaky: Fence = function* () { if (++calls === 2) throw new Error('audit write refused') }
  assert.deepEqual(await runDueWatches(db, { now: due, env: NO_TRIAL, fence: flaky }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal(Number((await watch(db, wa))!.next_run_at), FIN + DAY, 'A untouched: retried by the next tick')
  assert.equal((await jobsAt(db, B, due)).length, 1, 'B ran')
  assert.ok(wb)
  // the same inside the run's own transaction (the fence runs first there too): A's due run throws in its job
  // transaction and is recorded, B still has its last run queued (one scan at a time: deferred), C runs
  const C3 = 'c'.repeat(32); const wc = await firstPlay(db, C3, 'c@c.example')
  const next = due + DAY
  await db.run('UPDATE watches SET next_run_at = ? WHERE id IN (?, ?)', [next, wb, wc])
  let n2 = 0
  const failsInRun: Fence = function* () { if (++n2 === 3) throw new Error('job write refused') }
  assert.deepEqual(await runDueWatches(db, { now: next, env: NO_TRIAL, fence: failsInRun }), { ran: 1, paused: 0, skipped: 0 })
  assert.deepEqual((await db.all<{ user_id: string }>('SELECT user_id FROM scan_jobs WHERE created_at = ?', [next])).map(x => x.user_id), [C3])
  assert.equal(Number((await watch(db, wa))!.next_run_at), FIN + DAY, 'A untouched: due again on the next tick')
})

bothEngines('#1042 review 2: the skip notice stays until the play runs again, even 3 days later (a scheduler outage)', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  const due1 = FIN + DAY
  await scan(db, A, utcDayStart(due1) + H)
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 1 })
  // no tick since (outage): three days later the play has still not run, so Home and Plays still say why
  const [row] = await listWatches(db, A)
  assert.deepEqual(row.skipped, { at: due1, reason: 'free_daily_cap', next_run_at: due1 + DAY })
  assert.ok(skipNoticeLine([row]))
  // once it runs, the notice is gone
  assert.deepEqual(await runDueWatches(db, { now: due1 + 3 * DAY, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal((await listWatches(db, A))[0].skipped, null)
  assert.ok(w)
})

bothEngines('#1042 review 4: a failed pull-in is recorded and the due runs still happen', async ({ db }) => {
  await firstPlay(db, A, 'a@a.example')
  let n = 0
  const pullFails: Fence = function* () { if (++n === 1) throw new Error('pull-in refused') }
  assert.deepEqual(await runDueWatches(db, { now: FIN + DAY, env: NO_TRIAL, fence: pullFails }), { ran: 1, paused: 0, skipped: 0 })
})

bothEngines('#1042 review 3: a repeat created by a late tick keeps the first play\'s time of day', async ({ db }) => {
  await account(db, A, 'a@a.example'); await giveKey(db, A)
  await scan(db, A, T0)
  // the tick that creates the repeat runs 30 h after the first play finished (inside the 2-day window)
  const [w] = await repeatFirstPlays(db, { now: FIN + 30 * H })
  assert.equal(Number((await watch(db, w))!.next_run_at), FIN + 2 * DAY, 'the next 15:05, not "now + 60 s"')
  // the rule at its edges: on time, just before a day, exactly a day, and never less than a minute away
  assert.equal(firstRepeatAt(FIN, FIN + 60), FIN + DAY)
  assert.equal(firstRepeatAt(FIN, FIN + DAY - 30), FIN + 2 * DAY)
  assert.equal(firstRepeatAt(FIN, FIN + DAY + 1), FIN + 2 * DAY)
  assert.equal(firstRepeatAt(FIN, FIN + 47 * H), FIN + 2 * DAY)
})

bothEngines('#1042 review 4: a first-play repeat created weekly before the deploy runs within a day; hand-made weekly watches stay weekly', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  // as the pre-deploy code created it: next run a week after the first play finished
  await db.run('UPDATE watches SET next_run_at = ? WHERE id = ?', [FIN + WEEK_S, w])
  await account(db, B, 'b@b.example'); await giveKey(db, B)
  const hand = (await createWatch(db, B, 'Roofers in Ohio', '{"summary":"Roofers"}', null, T0)).watch!
  // a lost lease writes nothing
  const lost: Fence = function* () { throw new LeaseLost('scheduler', 'fixture') }
  await assert.rejects(pullInWeeklyRepeats(db, FIN + 2 * H, lost), LeaseLost)
  assert.equal(Number((await watch(db, w))!.next_run_at), FIN + WEEK_S)
  // the next tick, two hours after the deploy: pulled in to a day after its last run (the first play, T0)
  assert.equal(await pullInWeeklyRepeats(db, FIN + 2 * H), 1)
  assert.equal(Number((await watch(db, w))!.next_run_at), T0 + DAY)
  assert.equal(await pullInWeeklyRepeats(db, FIN + 2 * H + 60), 0, 'idempotent')
  assert.equal(Number((await watch(db, hand.id))!.next_run_at), T0 + WEEK_S, 'a hand-made watch is untouched')
  // and it runs within the day; afterwards it is daily
  const at = T0 + DAY
  assert.deepEqual(await runDueWatches(db, { now: at, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal(Number((await watch(db, w))!.next_run_at), at + DAY)
  // a repeat whose day-after-last-run has already passed is due now (runDueWatches pulls it in itself)
  const C3 = 'c'.repeat(32); const wc = await firstPlay(db, C3, 'c@c.example')
  await db.run('UPDATE watches SET next_run_at = ? WHERE id = ?', [FIN + WEEK_S, wc])
  const late = T0 + 3 * DAY
  assert.deepEqual(await runDueWatches(db, { now: late, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal((await jobsAt(db, C3, late)).length, 1)
})

bothEngines('#1042 paid plan: no daily cap; the plan\'s quota decides and the play keeps its own budget', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  await savePlan(db, A, 'pro')
  const due1 = FIN + DAY
  await scan(db, A, utcDayStart(due1) + H)
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal((await jobsAt(db, A, due1))[0].run_budget, null)
  assert.equal(Number((await watch(db, w))!.next_run_at), due1 + DAY)
  assert.deepEqual(await skips(db, A), [])
})

bothEngines('#1042 Find leads now on the free plan: once a scan ran today it is refused until tomorrow, writing nothing; paid plans run', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  // later on the first play's own day: that play was today's scan
  const click = FIN + 2 * H
  const before = await watch(db, w)
  const r = await runPlayNow(db, A, 'watch', w, click, NO_TRIAL)
  assert.deepEqual(r, { error: 'daily_cap', retry_at: utcDayStart(click) + DAY })
  assert.deepEqual(await watch(db, w), before, 'schedule untouched')
  assert.equal(await num(db, 'SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [A]), 1)
  const msg = runNowMessage(429, r as never, 'UTC')
  assert.equal(msg.ok, false)
  assert.match(msg.text, /^The free plan runs this play once a day and a search already ran today\. It can run again after /)
  // the next day it runs and moves the next scheduled run a day out (own key: no added budget)
  const next = utcDayStart(click) + DAY + 9 * H
  const ok = await runPlayNow(db, A, 'watch', w, next, NO_TRIAL)
  assert.ok('job_id' in ok, JSON.stringify(ok))
  assert.equal(ok.next_run_at, next + DAY)
  assert.equal((await jobsAt(db, A, next))[0].run_budget, null)
  // on a paid plan the same click the same day runs (the plan's quota decides), with the play's own budget
  await account(db, B, 'b@b.example'); await giveKey(db, B); await scan(db, B, T0)
  const [wb] = await repeatFirstPlays(db, { now: FIN + 60 })
  await savePlan(db, B, 'pro')
  const pb = await runPlayNow(db, B, 'watch', wb, click, NO_TRIAL)
  assert.ok('job_id' in pb, JSON.stringify(pb))
  assert.equal((await jobsAt(db, B, click))[0].run_budget, null)
})

bothEngines('#1042 the new-leads email names the play\'s real cadence: every day for the first play\'s repeat', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  await scan(db, A, FIN + DAY, { watchId: w, company: 'Smile Leeds' })
  assert.equal(await sendPlayRunMails(db, { now: FIN + DAY + H }), 1)
  const m = await db.get<{ body: string }>('SELECT body FROM system_mail_outbox WHERE user_id = ?', [A])
  assert.match(m!.body, /This play runs again every day\./)
  assert.match(composePlayRunMail({ userId: B, to: 'b@b.example', jobId: 'f'.repeat(24), query: Q, icp: ICP, total: 1, leads: [], base: 'https://dazl.ai' }).text, /This play runs again every week\./)
})

test('#1042 cadence helpers: a skipped run keeps its time of day; the free budget only ever narrows', () => {
  const day = utcDayStart(1_800_000_000)
  assert.equal(nextDayRun(day + 15 * H, day + 15 * H), day + DAY_S + 15 * H)
  assert.equal(nextDayRun(day - 3 * DAY_S + 15 * H, day + 16 * H), day + DAY_S + 15 * H, 'a run missed for days: once, tomorrow, never a burst')
  assert.equal(nextDayRun(day + DAY_S + H, day + 2 * H), day + DAY_S + H, 'already tomorrow: unchanged')
  assert.deepEqual(JSON.parse(cappedRunBudget(null)), { max_usd: 0.3 })
  assert.deepEqual(JSON.parse(cappedRunBudget('{"max_usd":5,"judge":false}')), { max_usd: 0.3, judge: false })
  assert.deepEqual(JSON.parse(cappedRunBudget('{"max_usd":0.1}')), { max_usd: 0.1 })
  assert.deepEqual(JSON.parse(cappedRunBudget('not json')), { max_usd: 0.3 })
  assert.deepEqual(JSON.parse(cappedRunBudget('[1]')), { max_usd: 0.3 })
})
