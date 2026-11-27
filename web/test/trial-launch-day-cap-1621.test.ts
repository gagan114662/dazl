// #1621: the shared daily free-trial allowance is $40 on Friday 2026-11-27 and the configured amount
// ($13.33) again from midnight, with nothing to switch by hand; and "a day" is the platform day (UTC).
// (#2054 as corrected on review: the lift is a property of the platform day, not of any account's local
// date - the fixture accounts below carry a saved Toronto zone, and admission must not use it.)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, globalDailyCapUsd, LAUNCH_DAY, trialDate, trialDay, trialDayStart } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
// The day the wallet runs on: the platform (UTC) day. The helpers take the zone that owns the day in
// question; for this wallet that is always UTC.
const ZONE = 'UTC'
// The fixture accounts' saved zone (below): kept to prove the wallet does not follow it.
const ACCOUNT_ZONE = 'America/Toronto'
const LAUNCH_START = at('2026-11-27T00:00:00Z'), LAUNCH_END = at('2026-11-28T00:00:00Z')
const ENV = { DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '13.33' }

test('#1621 the day is the platform (UTC) calendar day: it turns at UTC midnight, winter and summer', () => {
  assert.equal(trialDate(LAUNCH_START - 1, ZONE), '2026-11-26')
  assert.equal(trialDate(LAUNCH_START, ZONE), '2026-11-27')
  assert.equal(trialDate(at('2026-11-28T02:00:00Z'), ZONE), '2026-11-28', 'already Saturday on the platform day, though still Friday evening in Toronto')
  assert.equal(trialDate(at('2026-11-28T02:00:00Z'), ACCOUNT_ZONE), '2026-11-27', 'the day math itself is zone-general; the wallet passes UTC')
  assert.equal(trialDay(LAUNCH_START, ZONE) - trialDay(LAUNCH_START - 1, ZONE), 1)
  assert.equal(trialDayStart(trialDay(LAUNCH_START + 3600, ZONE), ZONE), LAUNCH_START)
  const july = at('2026-07-10T00:00:00Z')
  assert.equal(trialDayStart(trialDay(july + 7200, ZONE), ZONE), july, 'no clock change on the platform day: midnight is 00:00 UTC in summer too')
  assert.equal(trialDay(july - 1, ZONE), trialDay(july, ZONE) - 1)
})

test('#1621 the allowance for a day: $40 on launch day only, the configured amount on every other day', () => {
  assert.deepEqual(LAUNCH_DAY, { date: '2026-11-27', fromUsd: 13.33, toUsd: 40 })
  const cap = (iso: string, env: Record<string, string | undefined> = {}) => globalDailyCapUsd(13.33, trialDay(at(iso), ZONE), env)
  assert.equal(cap('2026-11-26T23:59:59Z'), 13.33, 'Thursday 11:59pm UTC')
  assert.equal(cap('2026-11-27T00:00:00Z'), 40, 'Friday midnight UTC: launch day')
  assert.equal(cap('2026-11-27T23:59:59Z'), 40, 'Friday 11:59pm UTC')
  assert.equal(cap('2026-11-28T00:00:00Z'), 13.33, 'Saturday midnight UTC: back by itself')
  assert.equal(cap('2027-11-27T17:00:00Z'), 13.33, 'not every year')
  for (const other of [10, 0.5, 13.34, 100]) assert.equal(globalDailyCapUsd(other, trialDay(at('2026-11-27T17:00:00Z'), ZONE), {}), other, 'only the $13.33 allowance is lifted: any other configured ceiling (a test, another deployment) is kept that day')
  assert.equal(globalDailyCapUsd(10, trialDay(at('2026-11-27T17:00:00Z'), ZONE), { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: '2026-11-27=40' }), 40, 'a date set by hand applies whatever the amount')
  assert.equal(cap('2026-11-27T17:00:00Z', { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: 'off' }), 13.33, 'switched off')
  assert.equal(cap('2026-12-04T17:00:00Z', { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: '2026-12-04=25, junk, 2026-12-05=-3' }), 25)
  assert.equal(cap('2026-12-05T17:00:00Z', { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: '2026-12-04=25, junk, 2026-12-05=-3' }), 13.33, 'a bad amount is ignored')
})

let n = 0
const user = async (db: Db) => {
  const id = (++n).toString(16).padStart(32, '0'), email = `u${n}@gmail.com`
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  // a Toronto account - the zone saved at signup, in the column readAccountZone reads when the schema
  // has it (added here until the schema grows it for real). The wallet must NOT follow it: the global
  // day is the platform's (UTC), so these accounts lift and refuse on UTC dates, not Toronto ones.
  await db.run('ALTER TABLE users ADD COLUMN timezone TEXT').catch(() => {})
  await db.run('UPDATE users SET timezone = ? WHERE id = ?', [ACCOUNT_ZONE, id])
  return { id, email }
}
// how many $1 free scans the deployment admits at this moment before the shared daily allowance refuses
const admitted = async (db: Db, now: number) => {
  for (let i = 0; i < 60; i++) {
    const a = await admitTrialScan(db, await user(db), { env: ENV, now })
    if (!a.ok) { assert.equal(a.reason, 'global_daily_cap'); return i }
  }
  return 60
}

bothEngines('#1621 admission: 13 one-dollar scans on Thursday, 40 on launch Friday, 13 again on Saturday; each day starts fresh at UTC midnight', async ({ db }) => {
  assert.equal(await admitted(db, LAUNCH_START - 3600), 13, 'Thursday 11pm UTC: $13.33')
  // those 13 are still running (unsettled), so they keep counting: launch day has $40 - $13 left
  assert.equal(await admitted(db, LAUNCH_START + 60), 27, 'Friday 12:01am UTC: the $40 day has begun')
  assert.deepEqual(await admitTrialScan(db, await user(db), { env: ENV, now: LAUNCH_END - 60 }), { ok: false, reason: 'global_daily_cap' }, 'Friday 11:59pm UTC: full')
  assert.deepEqual(await admitTrialScan(db, await user(db), { env: ENV, now: LAUNCH_END + 60 }), { ok: false, reason: 'global_daily_cap' }, 'Saturday: $13.33 again, and 40 scans are still running')
})

bothEngines('#1621 a scan admitted at 9pm Toronto counts toward the platform (UTC) day it was admitted on, and Toronto midnight opens nothing', async ({ db }) => {
  const env = { ...ENV, DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: 'off', DAZL_TRIAL_GLOBAL_DAILY_USD: '2' }
  const evening = at('2026-12-02T02:00:00Z') // Wednesday 2am UTC, Tuesday 9pm in Toronto
  const a = await user(db), b = await user(db)
  for (const u of [a, b]) {
    const r = await admitTrialScan(db, u, { env, now: evening }); assert.ok(r.ok)
    const job = `job${String(++n).padStart(21, '0')}`
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at, attempts, spend_reserved_usd) VALUES (?, ?, 'b', 'i', 'l', 'done', ?, 1, 1)", [job, u.id, evening]) // each cost its full dollar
    await db.run('UPDATE trial_reservations SET job_id = ?, settled_at = ?, settled_attempt = 1 WHERE id = ?', [job, evening + 600, r.reservation])
  }
  assert.deepEqual(await admitTrialScan(db, await user(db), { env, now: evening + 3600 }), { ok: false, reason: 'global_daily_cap' }, '3am UTC: the same platform day, full')
  assert.deepEqual(await admitTrialScan(db, await user(db), { env, now: at('2026-12-02T05:00:30Z') }), { ok: false, reason: 'global_daily_cap' }, 'Toronto midnight does not open a new day: the platform day is still Dec 2')
  assert.equal((await admitTrialScan(db, await user(db), { env, now: at('2026-12-03T00:00:30Z') })).ok, true, 'UTC midnight: a new platform day')
})
