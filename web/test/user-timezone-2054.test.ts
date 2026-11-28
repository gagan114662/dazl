// #2054 follow-up: users.timezone - the account's IANA time zone. Captured at password signup from the browser's
// zone (the sign-up form's JSON body); Google and native-form sign-ups have none until the Settings panel prefills
// the browser's zone as an unsaved field value, which the panel's Save stores through /api/settings/profile.
// lib/account-zone.ts readAccountZone reads it for the account's own day
// (#2074). The write boundary in lib/auth-db.ts keeps only a zone Intl can use: an invalid zone stores NULL and a
// signup never fails over it; NULL reads as no saved zone and every caller falls back to UTC. Both engines.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createPasswordUser, migrateAuth, readUserTimezone, writeUserTimezone } from '../lib/auth-db.ts'
import { readAccountZone } from '../lib/account-zone.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'

const base = { name: 'N', business_name: 'Biz', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }
const stored = async (db: Db, id: string) => (await db.get<{ tz: unknown }>('SELECT timezone AS tz FROM users WHERE id = ?', [id]))?.tz ?? null

bothEngines('#2054 a password signup with a valid zone stores it, and readAccountZone reads it back on the real schema', async ({ db }) => {
  assert.equal(await createPasswordUser({ ...base, id: 'Z1', email: 'z1@example.test', timezone: 'America/Toronto' }, db), 'created')
  assert.equal(await stored(db, 'Z1'), 'America/Toronto')
  assert.equal(await readUserTimezone(db, 'Z1'), 'America/Toronto')
  assert.equal(await readAccountZone(db, 'Z1'), 'America/Toronto', "the #2074 day reader sees the saved zone now that the column exists")
})

bothEngines('#2054 an invalid zone at signup stores NULL and the signup still succeeds; no zone stores NULL', async ({ db }) => {
  assert.equal(await createPasswordUser({ ...base, id: 'Z2', email: 'z2@example.test', timezone: 'Not/AZone' }, db), 'created')
  assert.equal(await stored(db, 'Z2'), null, 'junk is never stored')
  assert.equal(await readUserTimezone(db, 'Z2'), null)
  assert.equal(await readAccountZone(db, 'Z2'), null, 'no saved zone: callers fall back to UTC')
  assert.equal(await createPasswordUser({ ...base, id: 'Z3', email: 'z3@example.test' }, db), 'created')
  assert.equal(await stored(db, 'Z3'), null, 'a signup with no zone (Google, native form) starts with none')
  assert.equal(await createPasswordUser({ ...base, id: 'Z4', email: 'z4@example.test', timezone: '' }, db), 'created')
  assert.equal(await stored(db, 'Z4'), null)
})

bothEngines('#2054 the Settings write path updates the zone, clears on null, and never stores junk', async ({ db }) => {
  assert.equal(await createPasswordUser({ ...base, id: 'Z5', email: 'z5@example.test' }, db), 'created')
  await writeUserTimezone(db, 'Z5', 'Australia/Sydney')
  assert.equal(await stored(db, 'Z5'), 'Australia/Sydney')
  assert.equal(await readAccountZone(db, 'Z5'), 'Australia/Sydney')
  await writeUserTimezone(db, 'Z5', 'Not/AZone')
  assert.equal(await stored(db, 'Z5'), null, 'the write boundary refuses junk even if a caller forgets to validate')
  await writeUserTimezone(db, 'Z5', 'Asia/Dubai')
  assert.equal(await readUserTimezone(db, 'Z5'), 'Asia/Dubai')
  await writeUserTimezone(db, 'Z5', null)
  assert.equal(await stored(db, 'Z5'), null, 'null clears back to the UTC fallback')
})

test('#2054 the column is additive and re-runnable: rows made before it read NULL; running the migrations again changes nothing', () => {
  const d = new Database(':memory:')
  migrateAllSqlite(d)
  d.exec('ALTER TABLE users DROP COLUMN timezone')
  d.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('old', 'old@example.test', 'O', 'O', 'h', 's')").run()
  migrateAuth(d)
  migrateAllSqlite(d)
  migrateAuth(d)
  assert.equal((d.prepare("SELECT timezone AS tz FROM users WHERE id = 'old'").get() as { tz: unknown }).tz, null)
  const n = (d.prepare("SELECT count(*) AS n FROM pragma_table_info('users') WHERE name = 'timezone'").get() as { n: number }).n
  assert.equal(n, 1)
})
