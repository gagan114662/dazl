// #2054, Ziggy's correction on review: the GLOBAL trial ceiling is platform money, so it keeps ONE platform
// day - the UTC day - for every account. Account zones govern per-account limits and shown reset times, never
// this ceiling: if admission bucketed each reservation by the admitting account's own zone day, accounts in
// different zones would draw on different "days" and the day's total trial spend could pass the global cap.
// Synthetic accounts only; the zones are saved on the user rows the way the signup capture will save them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { admitTrialScan, trialAllowanceLeft, trialDay } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
// One fixed instant, three dates: Sydney is already on Nov 27, Los Angeles and UTC still on Nov 26.
const T = at('2026-11-26T16:30:00Z')
const ENV = { DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5', DAZL_TRIAL_GLOBAL_DAILY_USD: '10' }

let n = 0
const user = async (db: Db, zone: string) => {
  const id = (++n).toString(16).padStart(32, '0'), email = `u${n}@gmail.com`
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  // the zone saved at signup, in the column readAccountZone reads when the schema has it (added here until
  // the schema grows it for real - the same fixture shape as test/trial-launch-day-cap-1621.test.ts)
  await db.run('ALTER TABLE users ADD COLUMN timezone TEXT').catch(() => {})
  await db.run('UPDATE users SET timezone = ? WHERE id = ?', [zone, id])
  return { id, email }
}
// how many $1 free scans fresh accounts of one zone admit at this moment before the shared daily allowance refuses
const admitted = async (db: Db, zone: string, now: number, env: Record<string, string | undefined> = ENV) => {
  for (let i = 0; i < 60; i++) {
    const a = await admitTrialScan(db, await user(db, zone), { env, now })
    if (!a.ok) { assert.equal(a.reason, 'global_daily_cap'); return i }
  }
  return 60
}

bothEngines('#2054 the global trial day is one platform (UTC) day: a zone ahead cannot hide its spend from a zone behind', async ({ db }) => {
  assert.equal(await admitted(db, 'Australia/Sydney', T), 10, 'Sydney accounts fill the shared $10 day')
  const rows = await db.all<{ day: number }>('SELECT day FROM trial_reservations')
  assert.equal(rows.length, 10)
  assert.ok(rows.every(r => Number(r.day) === trialDay(T, 'UTC')), 'every reservation carries the UTC platform day, whatever the account zone')
  assert.deepEqual(await admitTrialScan(db, await user(db, 'America/Los_Angeles'), { env: ENV, now: T }),
    { ok: false, reason: 'global_daily_cap' },
    'Los Angeles, on an earlier local date at the same instant, is refused: the day is shared, not per-zone')
})

// The same split-zone case as the first bothEngines test, declared as a plain test() so the tagged-test
// gate (scripts/gate-check.mjs) selects this file and counts the case: the gate's scan recognises a
// test()/it() declaration, and bothEngines declarations are invisible to it.
test('#2054 the global trial day is one platform (UTC) day: the split-zone case on sqlite', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  assert.equal(await admitted(db, 'Australia/Sydney', T), 10, 'Sydney accounts fill the shared $10 day')
  const rows = await db.all<{ day: number }>('SELECT day FROM trial_reservations')
  assert.equal(rows.length, 10)
  assert.ok(rows.every(r => Number(r.day) === trialDay(T, 'UTC')), 'every reservation carries the UTC platform day, whatever the account zone')
  assert.deepEqual(await admitTrialScan(db, await user(db, 'America/Los_Angeles'), { env: ENV, now: T }),
    { ok: false, reason: 'global_daily_cap' },
    'Los Angeles, on an earlier local date at the same instant, is refused: the day is shared, not per-zone')
  raw.close()
})

bothEngines('#2054 control: two groups in the SAME zone share the day exactly as before', async ({ db }) => {
  assert.equal(await admitted(db, 'America/Toronto', T), 10, 'Toronto accounts fill the shared $10 day')
  assert.deepEqual(await admitTrialScan(db, await user(db, 'America/Toronto'), { env: ENV, now: T }),
    { ok: false, reason: 'global_daily_cap' }, 'the next Toronto account is refused, as it was before zones')
})

bothEngines('#2054 per-account limits stay the account\'s own across the shared platform day', async ({ db }) => {
  const env = { ...ENV, DAZL_TRIAL_GLOBAL_DAILY_USD: '100' }
  const syd = await user(db, 'Australia/Sydney'), la = await user(db, 'America/Los_Angeles')
  for (const u of [syd, la]) {
    for (let i = 0; i < 3; i++) assert.ok((await admitTrialScan(db, u, { env, now: T })).ok)
    assert.deepEqual(await admitTrialScan(db, u, { env, now: T }), { ok: false, reason: 'attempts_cap' },
      'the fourth scan meets the account\'s own attempts cap, not the shared day')
    assert.deepEqual(await trialAllowanceLeft(db, u.id, { env, now: T }), { left_usd: 2, total_usd: 5 },
      'each account\'s allowance counts only its own $3 of spend')
  }
})
