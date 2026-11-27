// #2054: send caps reset on the ACCOUNT's own time zone (saved at signup, falling back to UTC), through one
// shared helper (lib/account-zone.ts) - not midnight Toronto for every account, now that dazl launches
// worldwide. The GLOBAL trial ceiling is the exception: it keeps the one UTC platform day for every account
// (test/trial-global-day-2054.test.ts). Cap amounts are unchanged; only the day boundary moves. Synthetic rows only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import {
  FALLBACK_ZONE, validZone, zoneOrFallback, dateInZone, dayNumber, dayStartUnix, dayStartOfInstant,
  readAccountZone,
} from '../lib/account-zone.ts'
import { ACCOUNT_SEND_CAP, sendDayStart } from '../lib/outreach/send-budget.ts'
import { trialCaps, trialDate, trialDay, trialDayStart } from '../lib/billing/trial-budget.ts'
import { dailyCapMessage } from '../lib/outreach/send-cap-copy.ts'
import { bothEngines } from './helpers/engines.ts'

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000
// Two fixed instants at which the four zones sit on different local dates.
const T1 = utc(2026, 11, 26, 2, 30) // Toronto still on Nov 25; UTC, Sydney and Dubai on Nov 26
const T2 = utc(2026, 11, 26, 16, 30) // Sydney already on Nov 27; the others on Nov 26
const dayNum = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / 86400000)

// [zone, date at T1, day start at T1, date at T2, day start at T2] - day starts as UTC instants.
const ZONES: [string, string, number, string, number][] = [
  ['UTC', '2026-11-26', utc(2026, 11, 26), '2026-11-26', utc(2026, 11, 26)],
  ['America/Toronto', '2026-11-25', utc(2026, 11, 25, 5), '2026-11-26', utc(2026, 11, 26, 5)],
  ['Australia/Sydney', '2026-11-26', utc(2026, 11, 25, 13), '2026-11-27', utc(2026, 11, 26, 13)],
  ['Asia/Dubai', '2026-11-26', utc(2026, 11, 25, 20), '2026-11-26', utc(2026, 11, 25, 20)],
]

test('#2054 the shared helper: the local date, day number and day start in four zones at two instants', () => {
  for (const [zone, date1, start1, date2, start2] of ZONES) {
    const [y1, m1, d1] = date1.split('-').map(Number), [y2, m2, d2] = date2.split('-').map(Number)
    assert.equal(dateInZone(T1, zone), date1, `${zone} date at T1`)
    assert.equal(dateInZone(T2, zone), date2, `${zone} date at T2`)
    assert.equal(dayNumber(T1, zone), dayNum(y1, m1, d1), `${zone} day number at T1`)
    assert.equal(dayNumber(T2, zone), dayNum(y2, m2, d2), `${zone} day number at T2`)
    assert.equal(dayStartUnix(dayNumber(T1, zone), zone), start1, `${zone} day start at T1`)
    assert.equal(dayStartUnix(dayNumber(T2, zone), zone), start2, `${zone} day start at T2`)
    assert.equal(dayStartOfInstant(T1, zone), start1, `${zone} start of the day holding T1`)
    assert.equal(dayStartOfInstant(T2, zone), start2, `${zone} start of the day holding T2`)
    // the day holding the instant runs from its start to the next day's start, and the instant is inside it
    assert.ok(dayStartOfInstant(T1, zone) <= T1 && T1 < dayStartUnix(dayNumber(T1, zone) + 1, zone), `${zone} T1 inside its day`)
  }
})

test('#2054 clock-change days are exact: 23h and 25h days in Toronto, a 25h day in Sydney', () => {
  const spring = dayNumber(utc(2026, 3, 8, 17), 'America/Toronto') // 2026-03-08, clocks jump forward
  assert.equal(dateInZone(utc(2026, 3, 8, 17), 'America/Toronto'), '2026-03-08')
  assert.equal(dayStartUnix(spring, 'America/Toronto'), utc(2026, 3, 8, 5), 'the spring day starts at midnight EST')
  assert.equal(dayStartUnix(spring + 1, 'America/Toronto') - dayStartUnix(spring, 'America/Toronto'), 23 * 3600)
  const fall = dayNumber(utc(2026, 11, 1, 17), 'America/Toronto') // 2026-11-01, clocks fall back
  assert.equal(dateInZone(utc(2026, 11, 1, 17), 'America/Toronto'), '2026-11-01')
  assert.equal(dayStartUnix(fall, 'America/Toronto'), utc(2026, 11, 1, 4), 'the fall day starts at midnight EDT')
  assert.equal(dayStartUnix(fall + 1, 'America/Toronto') - dayStartUnix(fall, 'America/Toronto'), 25 * 3600)
  const sydneyFall = dayNumber(utc(2026, 4, 5, 12), 'Australia/Sydney') // 2026-04-05, AEDT ends
  assert.equal(dateInZone(utc(2026, 4, 5, 12), 'Australia/Sydney'), '2026-04-05')
  assert.equal(dayStartUnix(sydneyFall + 1, 'Australia/Sydney') - dayStartUnix(sydneyFall, 'Australia/Sydney'), 25 * 3600)
})

test('#2054 the fallback: a missing or unreadable zone is UTC, never a throw, never Toronto', () => {
  assert.equal(FALLBACK_ZONE, 'UTC')
  assert.equal(validZone('America/Toronto'), true)
  assert.equal(validZone('Australia/Sydney'), true)
  assert.equal(validZone('Bogus/Zone'), false)
  assert.equal(validZone(''), false)
  assert.equal(zoneOrFallback('Asia/Dubai'), 'Asia/Dubai')
  assert.equal(zoneOrFallback('Bogus/Zone'), 'UTC')
  assert.equal(zoneOrFallback(null), 'UTC')
  assert.equal(zoneOrFallback(undefined), 'UTC')
  assert.equal(zoneOrFallback(), 'UTC')
})

test('#2054 the account-zone reader: no timezone column yet means no saved zone (null), on the real schema', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES ('A', 'owner@seller.example', 'x', 'y', 1000)").run()
  assert.equal(await readAccountZone(sqliteDb(raw), 'A'), null, 'no timezone column: nothing saved, the caller falls back')
  assert.equal(await readAccountZone(sqliteDb(raw), 'missing'), null)
  raw.close()
})

bothEngines('#2054 readAccountZone on the real schema: no column, no saved zone, on both engines', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('A', 'owner@seller.example', 'n', 'b', 'x', 'y')")
  assert.equal(await readAccountZone(db, 'A'), null)
  assert.equal(await readAccountZone(db, 'missing'), null)
})

test('#2054 readAccountZone (Db layer) returns a saved zone once the column exists; an unreadable saved value is no zone', async () => {
  const scratch = () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, timezone TEXT); CREATE TABLE organizations (id TEXT PRIMARY KEY, timezone TEXT)')
    return db
  }
  const saved = scratch()
  saved.prepare("INSERT INTO users (id, timezone) VALUES ('A', 'Australia/Sydney')").run()
  assert.equal(await readAccountZone(sqliteDb(saved), 'A'), 'Australia/Sydney')
  const orgOnly = scratch()
  orgOnly.prepare("INSERT INTO organizations (id, timezone) VALUES ('W', 'Asia/Dubai')").run()
  assert.equal(await readAccountZone(sqliteDb(orgOnly), 'W'), 'Asia/Dubai', 'the workspace row answers when the user row does not')
  const bad = scratch()
  bad.prepare("INSERT INTO users (id, timezone) VALUES ('A', 'Not/AZone')").run()
  assert.equal(await readAccountZone(sqliteDb(bad), 'A'), null, 'a saved value that is not a real zone is no zone: the caller falls back to UTC')
  assert.equal(zoneOrFallback(await readAccountZone(sqliteDb(bad), 'A')), 'UTC')
  const empty = scratch()
  assert.equal(await readAccountZone(sqliteDb(empty), 'A'), null, 'no row: no zone')
  assert.equal(await readAccountZone(sqliteDb(empty), 'missing'), null)
})

test('#2054 sendDayStart: the sending day starts at midnight in the given zone; no zone is UTC now', () => {
  assert.equal(sendDayStart(T2, 'America/Toronto'), utc(2026, 11, 26, 5))
  assert.equal(sendDayStart(T2, 'Australia/Sydney'), utc(2026, 11, 26, 13))
  assert.equal(sendDayStart(T2, 'Asia/Dubai'), utc(2026, 11, 25, 20))
  assert.equal(sendDayStart(T2), utc(2026, 11, 26), 'no zone resolves to the UTC fallback until the caller passes the account zone')
  assert.equal(sendDayStart(T2, 'Bogus/Zone'), utc(2026, 11, 26))
  assert.equal(sendDayStart(T1, 'America/Toronto'), utc(2026, 11, 25, 5), 'T1 is still Nov 25 in Toronto')
})

test('#2054 the trial day helpers: trialDate, trialDay and trialDayStart take the zone that owns the day', () => {
  for (const [zone, date1, start1, date2, start2] of ZONES) {
    assert.equal(trialDate(T1, zone), date1, `${zone} trial date at T1`)
    assert.equal(trialDate(T2, zone), date2, `${zone} trial date at T2`)
    assert.equal(trialDay(T1, zone), dayNumber(T1, zone), `${zone} trial day at T1`)
    assert.equal(trialDay(T2, zone), dayNumber(T2, zone), `${zone} trial day at T2`)
    assert.equal(trialDayStart(trialDay(T1, zone), zone), start1, `${zone} trial day start at T1`)
    assert.equal(trialDayStart(trialDay(T2, zone), zone), start2, `${zone} trial day start at T2`)
  }
})

test('#2054 the cap copy names the zone the reset belongs to, in both branches, UTC fallback included', () => {
  const now = 1_800_000_000 // 2027-01-15 08:00 UTC
  const torontoMidnight = utc(2027, 1, 16, 5) // the next Toronto midnight
  assert.equal(dailyCapMessage(40, torontoMidnight, 'America/Toronto', now),
    "You've sent today's 40 emails. You can send the rest after midnight (America/Toronto time).")
  assert.equal(dailyCapMessage(40, torontoMidnight, 'America/Vancouver', now),
    "You've sent today's 40 emails. You can send the rest today at 10:00 PM (America/Vancouver time).",
    'the same instant in another zone is a clock time there, and the copy names that zone')
  assert.equal(dailyCapMessage(40, utc(2027, 1, 16), undefined, now),
    "You've sent today's 40 emails. You can send the rest after midnight (UTC time).",
    'no zone: the UTC fallback, named')
  assert.equal(dailyCapMessage(40, utc(2027, 1, 16), 'Bogus/Zone', now),
    "You've sent today's 40 emails. You can send the rest after midnight (UTC time).",
    'an unreadable zone: the UTC fallback, named, never a throw')
  assert.equal(dailyCapMessage(40, null, 'America/Toronto', now),
    "You've sent today's 40 emails. You can send the rest tomorrow.", 'no reset instant: still plain, no invented time')
})

test('#2054 cap amounts are unchanged', () => {
  assert.equal(ACCOUNT_SEND_CAP, 20)
  assert.deepEqual(
    trialCaps({ DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10' }),
    { reserveUsd: 0.3, accountTotalUsd: 1, globalDailyUsd: 10 })
})
