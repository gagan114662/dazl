// #1042 decision (Hermes, delegated by Gagan, 2026-11-12): "Daily, not weekly. The first play keeps finding new leads every
// day, on every plan including free, with a hard per-tenant cap: free plan 1 scan/day, at most $0.30, counted against the
// existing trial/spend caps; paid plans follow their quota. If the cap is hit, skip that day and say so on Home."
// Both engines; synthetic accounts and rows only. No network, no provider, no paid call: runs only QUEUE jobs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bothEngines } from './helpers/engines.ts'
import type { Db, Tx } from '../lib/db/client.ts'
import { createWatch, listWatches, runDueWatches, watchAction, type Fence } from '../lib/watch.ts'
import { repeatFirstPlays, REPEAT_INTERVAL_S } from '../lib/play-repeat.ts'
import { runPlayNow } from '../lib/play-now.ts'
import { runNowMessage } from '../lib/play-new-view.ts'
import { savedPlays } from '../lib/saved-plays.ts'
import { playPace } from '../lib/play-card.ts'
import { composePlayRunMail, sendPlayRunMails } from '../lib/play-mail.ts'
import { savePlan } from '../lib/plans.ts'
import { cappedRunBudget, DAY_S, FREE_RUN_MAX_USD, nextDayRun, PLAY_SKIPPED, utcDayStart, WEEK_S } from '../lib/play-cadence.ts'

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
async function scan(db: Db, t: string, at: number, o: { status?: 'done' | 'failed'; error?: string | null; watchId?: string; company?: string } = {}) {
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, created_at, watch_id) VALUES (?, ?, 'x', '-', '-', ?, ?, 'running', ?, ?)", [id, t, Q, ICP, at, o.watchId ?? null])
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
  const [row] = await listWatches(db, A, FIN + 120)
  assert.deepEqual([row.auto, row.interval_s, row.skipped], [true, DAY, null])
  const [p] = savedPlays([row] as never, null, 'UTC', FIN + 120)
  assert.equal(p.schedule, 'Daily')
  assert.match(p.note ?? '', /search again every day/)
  assert.match(playPace({ status: 'done', error: null, created_at: T0, query: Q }, [row]).pace, /^Runs every day, next .*Nothing is sent without your OK/)
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
  // a watch made by hand ("Watch this weekly") is unchanged: weekly on create, run and resume
  await account(db, B, 'b@b.example'); await giveKey(db, B)
  const hand = (await createWatch(db, B, 'Roofers in Ohio', '{"summary":"Roofers"}', null, D0)).watch!
  assert.equal(Number(hand.next_run_at), D0 + WEEK_S)
  assert.deepEqual(await runDueWatches(db, { now: D0 + WEEK_S, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  assert.equal(Number((await watch(db, hand.id))!.next_run_at), D0 + 2 * WEEK_S)
  assert.equal((await jobsAt(db, B, D0 + WEEK_S))[0].run_budget, null, 'a hand-made watch carries no added budget')
  const [hp] = savedPlays((await listWatches(db, B, D0 + WEEK_S)) as never, null, 'UTC', D0 + WEEK_S)
  assert.equal(hp.schedule, 'Weekly')
})

bothEngines('#1042 free plan: a scan already started today skips that day\'s run (same time tomorrow), and Plays and Home say so until it runs', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  const due1 = FIN + DAY
  // a genuine failure today gives its slot back (as the monthly count does): the run still happens
  await scan(db, A, utcDayStart(due1) + 2 * H, { status: 'failed', error: 'no_candidates' })
  // a search the person ran in Leads this morning is today's one scan
  await scan(db, A, utcDayStart(due1) + 8 * H)
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 1 })
  assert.deepEqual(await jobsAt(db, A, due1), [], 'no scan queued')
  assert.deepEqual([Number((await watch(db, w))!.next_run_at), (await watch(db, w))!.active], [due1 + DAY, 1], 'still live; moved to the same time tomorrow')
  const [ev] = await skips(db, A)
  assert.deepEqual([ev.resource_id, Number(ev.at), ev.actor_kind, JSON.parse(ev.summary)], [w, due1, 'service', { reason: 'free_daily_cap', due_at: due1, next_run_at: due1 + DAY, daily_runs: 1 }])
  // the next tick that day: not due any more, nothing more written
  assert.deepEqual(await runDueWatches(db, { now: due1 + 600, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 0 })
  assert.equal((await skips(db, A)).length, 1)
  // Plays and Home say why
  const [row] = await listWatches(db, A, due1 + 600)
  assert.deepEqual(row.skipped, { at: due1, reason: 'free_daily_cap', next_run_at: due1 + DAY })
  const [p] = savedPlays([row] as never, null, 'UTC', due1 + 600)
  assert.match(p.note ?? '', /^Today's search was skipped: the free plan runs 1 search a day and one already ran today\. Next search /)
  assert.match(playPace({ status: 'done', error: null, created_at: T0, query: Q }, [row]).pace, /Today's search was skipped: the free plan runs 1 search a day/)
  // the next day it runs, held to $0.30, and the notice goes away
  const due2 = due1 + DAY
  assert.deepEqual(await runDueWatches(db, { now: due2, env: NO_TRIAL }), { ran: 1, paused: 0, skipped: 0 })
  const [job] = await jobsAt(db, A, due2)
  assert.deepEqual(JSON.parse(job.run_budget!), { max_usd: FREE_RUN_MAX_USD })
  assert.equal((await listWatches(db, A, due2 + 60))[0].skipped, null)
  // a paused play shows no skip line
  await scan(db, A, utcDayStart(due2 + DAY) + H)
  await finishJob(db, job.id, due2 + 300)
  assert.deepEqual(await runDueWatches(db, { now: due2 + DAY, env: NO_TRIAL }), { ran: 0, paused: 0, skipped: 1 })
  await watchAction(db, A, w, 'pause')
  assert.equal((await listWatches(db, A, due2 + DAY + 60))[0].skipped, null)
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
  assert.equal(JSON.parse(job.run_budget!).max_usd, 0.3)
  assert.equal(Number((await watch(db, w))!.next_run_at), due1 + 2 * DAY)
})

bothEngines('#1042 the daily cap is re-checked inside the run\'s transaction: a scan started after the first check skips the day', async ({ db }) => {
  const w = await firstPlay(db, A, 'a@a.example')
  const due1 = FIN + DAY
  // the fence runs first in each of the tick's transactions: the second one (the job's) sees a scan a click just started
  let calls = 0
  const click: Fence = function* (t: Tx) { if (++calls === 2) yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '-', '-', 'q', 'done', ?)", [id24(), A, due1 - 60]) }
  assert.deepEqual(await runDueWatches(db, { now: due1, env: NO_TRIAL, fence: click }), { ran: 0, paused: 0, skipped: 1 })
  assert.deepEqual(await jobsAt(db, A, due1), [])
  assert.equal(Number((await watch(db, w))!.next_run_at), due1 + DAY)
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
  // the next day it runs, moves the next scheduled run a day out and carries the $0.30 budget
  const next = utcDayStart(click) + DAY + 9 * H
  const ok = await runPlayNow(db, A, 'watch', w, next, NO_TRIAL)
  assert.ok('job_id' in ok, JSON.stringify(ok))
  assert.equal(ok.next_run_at, next + DAY)
  assert.deepEqual(JSON.parse((await jobsAt(db, A, next))[0].run_budget!), { max_usd: 0.3 })
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
