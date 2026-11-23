// #1621: the shared daily free-trial allowance is $40 on Friday 2026-11-27 (Toronto time) and the configured amount
// ($13.33) again from midnight, with nothing to switch by hand; and "a day" starts at midnight in Toronto, not UTC.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, globalDailyCapUsd, LAUNCH_DAY_CAPS, trialDate, trialDay, trialDayStart } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
// Toronto is UTC-5 in late November and UTC-4 in July
const LAUNCH_START = at('2026-11-27T05:00:00Z'), LAUNCH_END = at('2026-11-28T05:00:00Z')
const ENV = { DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '13.33' }

test('#1621 the day is the Toronto calendar day: it turns at Toronto midnight, winter and summer', () => {
  assert.equal(trialDate(LAUNCH_START - 1), '2026-11-26')
  assert.equal(trialDate(LAUNCH_START), '2026-11-27')
  assert.equal(trialDate(at('2026-11-28T02:00:00Z')), '2026-11-27', '9pm in Toronto is still Friday, though UTC says Saturday')
  assert.equal(trialDay(LAUNCH_START) - trialDay(LAUNCH_START - 1), 1)
  assert.equal(trialDayStart(trialDay(LAUNCH_START + 3600)), LAUNCH_START)
  const july = at('2026-07-10T04:00:00Z')
  assert.equal(trialDayStart(trialDay(july + 7200)), july, 'summer time: midnight is 04:00 UTC')
  assert.equal(trialDay(july - 1), trialDay(july) - 1)
})

test('#1621 the allowance for a day: $40 on launch day only, the configured amount on every other day', () => {
  assert.deepEqual(LAUNCH_DAY_CAPS, { '2026-11-27': 40 })
  const cap = (iso: string, env: Record<string, string | undefined> = {}) => globalDailyCapUsd(13.33, trialDay(at(iso)), env)
  assert.equal(cap('2026-11-27T04:59:59Z'), 13.33, 'Thursday 11:59pm Toronto')
  assert.equal(cap('2026-11-27T05:00:00Z'), 40, 'Friday midnight Toronto')
  assert.equal(cap('2026-11-28T04:59:59Z'), 40, 'Friday 11:59pm Toronto')
  assert.equal(cap('2026-11-28T05:00:00Z'), 13.33, 'Saturday midnight Toronto: back by itself')
  assert.equal(cap('2027-11-27T17:00:00Z'), 13.33, 'not every year')
  assert.equal(cap('2026-11-27T17:00:00Z', { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: 'off' }), 13.33, 'switched off')
  assert.equal(cap('2026-12-04T17:00:00Z', { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: '2026-12-04=25, junk, 2026-12-05=-3' }), 25)
  assert.equal(cap('2026-12-05T17:00:00Z', { DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: '2026-12-04=25, junk, 2026-12-05=-3' }), 13.33, 'a bad amount is ignored')
})

let n = 0
const user = async (db: Db) => {
  const id = (++n).toString(16).padStart(32, '0'), email = `u${n}@gmail.com`
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
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

bothEngines('#1621 admission: 13 one-dollar scans on Thursday, 40 on launch Friday, 13 again on Saturday; each day starts fresh at Toronto midnight', async ({ db }) => {
  assert.equal(await admitted(db, LAUNCH_START - 3600), 13, 'Thursday 11pm Toronto: $13.33')
  // those 13 are still running (unsettled), so they keep counting: launch day has $40 - $13 left
  assert.equal(await admitted(db, LAUNCH_START + 60), 27, 'Friday 12:01am Toronto: the $40 day has begun')
  assert.deepEqual(await admitTrialScan(db, await user(db), { env: ENV, now: LAUNCH_END - 60 }), { ok: false, reason: 'global_daily_cap' }, 'Friday 11:59pm: full')
  assert.deepEqual(await admitTrialScan(db, await user(db), { env: ENV, now: LAUNCH_END + 60 }), { ok: false, reason: 'global_daily_cap' }, 'Saturday: $13.33 again, and 40 scans are still running')
})

bothEngines('#1621 a scan admitted at 9pm Toronto counts toward that Toronto day, not the next one (UTC had already turned)', async ({ db }) => {
  const env = { ...ENV, DAZL_TRIAL_GLOBAL_DAILY_BY_DATE: 'off', DAZL_TRIAL_GLOBAL_DAILY_USD: '2' }
  const evening = at('2026-12-02T02:00:00Z') // Tuesday 9pm in Toronto
  const a = await user(db), b = await user(db)
  for (const u of [a, b]) {
    const r = await admitTrialScan(db, u, { env, now: evening }); assert.ok(r.ok)
    const job = `job${String(++n).padStart(21, '0')}`
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at, attempts, spend_reserved_usd) VALUES (?, ?, 'b', 'i', 'l', 'done', ?, 1, 1)", [job, u.id, evening]) // each cost its full dollar
    await db.run('UPDATE trial_reservations SET job_id = ?, settled_at = ?, settled_attempt = 1 WHERE id = ?', [job, evening + 600, r.reservation])
  }
  assert.deepEqual(await admitTrialScan(db, await user(db), { env, now: evening + 3600 }), { ok: false, reason: 'global_daily_cap' }, '10pm: the same Toronto day, full')
  assert.equal((await admitTrialScan(db, await user(db), { env, now: at('2026-12-02T05:00:30Z') })).ok, true, 'Toronto midnight: a new day')
})
