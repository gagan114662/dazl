// Session inventory, revocation and expiry cleanup (lib/sessions.ts), on both engines.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createPasswordUser, createSession, deleteSession, getSessionUser, hasLiveSession, hashToken, migrateAuth, SESSION_TTL_S } from '../lib/auth-db.ts'
import { SEEN_EVERY_S, SESSION_RETAIN_S, deviceLabel, listSessions, reapSessions, revokeAllSessions, revokeSession } from '../lib/sessions.ts'
import { bothEngines } from './helpers/engines.ts'

const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: id, password_hash: 'h', salt: 's' })
const NOW = Math.floor(Date.now() / 1000)

bothEngines('a revoked or signed-out session fails at once and keeps who revoked it and when', async ({ db }) => {
  await createPasswordUser(user('A'), db)
  const t1 = await createSession('A', db, { device: 'Chrome on macOS' }), t2 = await createSession('A', db)
  const [row] = (await listSessions(db, 'A', hashToken(t1))).filter(s => s.current)
  assert.equal(row.device, 'Chrome on macOS')
  assert.match(row.public_id, /^[a-f0-9]{24}$/)
  assert.equal(await revokeSession(db, 'B', row.public_id, 'B'), false, "another account's id")
  assert.equal(await hasLiveSession(t1, db), true)
  assert.equal(await revokeSession(db, 'A', row.public_id, 'A', 'revoked', NOW), true)
  assert.equal(await getSessionUser(t1, db), null)
  assert.equal(await hasLiveSession(t1, db), false, 'the page gate refuses a revoked session too')
  assert.deepEqual(await db.get('SELECT revoked_at, revoked_by, revoke_reason FROM sessions WHERE id = ?', [hashToken(t1)]), { revoked_at: NOW, revoked_by: 'A', revoke_reason: 'revoked' })
  await deleteSession(t2, db)
  assert.equal(await getSessionUser(t2, db), null)
  assert.equal((await db.get<{ r: string }>('SELECT revoke_reason AS r FROM sessions WHERE id = ?', [hashToken(t2)]))?.r, 'signed_out')
  assert.deepEqual(await listSessions(db, 'A', null), [])
})

bothEngines('revoke all: every working session of that account, the kept one excepted; other accounts untouched', async ({ db }) => {
  await createPasswordUser(user('A'), db); await createPasswordUser(user('B'), db)
  const [a1, a2, a3, b1] = [await createSession('A', db), await createSession('A', db), await createSession('A', db), await createSession('B', db)]
  assert.equal(await revokeAllSessions(db, 'A', { by: 'A', reason: 'revoked_all', keepHash: hashToken(a1) }), 2)
  assert.ok(await getSessionUser(a1, db)); assert.equal(await getSessionUser(a2, db), null); assert.equal(await getSessionUser(a3, db), null)
  assert.equal(await revokeAllSessions(db, 'A', { by: 'support', reason: 'recovery' }), 1)
  assert.equal(await getSessionUser(a1, db), null)
  assert.ok(await getSessionUser(b1, db))
})

bothEngines('the reaper is bounded, keeps recent history, and never deletes a working session', async ({ db }) => {
  await createPasswordUser(user('A'), db)
  const old = NOW - SESSION_RETAIN_S - 10
  const add = (id: string, expires: number, revoked: number | null) => db.run('INSERT INTO sessions (id, user_id, expires_at, revoked_at, public_id) VALUES (?, ?, ?, ?, ?)', [id, 'A', expires, revoked, id.padEnd(24, '0')])
  for (let i = 0; i < 7; i++) await add(`exp${i}`, old, null)            // expired long ago
  await add('revold', NOW + SESSION_TTL_S, old)                          // revoked long ago
  await add('exprecent', NOW - 60, null)                                 // expired a minute ago: kept for now
  await add('revrecent', NOW + SESSION_TTL_S, NOW - 60)                  // revoked a minute ago: kept for now
  const live = await createSession('A', db)
  await add('liveold', NOW + 60, null)                                   // working, though created long ago
  assert.equal(await reapSessions(db, { now: NOW, limit: 5 }), 5, 'bounded')
  assert.equal(await reapSessions(db, { now: NOW, limit: 5 }), 3)
  assert.equal(await reapSessions(db, { now: NOW, limit: 5 }), 0)
  const left = (await db.all<{ id: string }>('SELECT id FROM sessions ORDER BY id')).map(r => r.id)
  assert.deepEqual(left, [hashToken(live), 'exprecent', 'liveold', 'revrecent'].sort())
  assert.ok(await getSessionUser(live, db))
  // a fence that refuses (a tick that lost its lease) deletes nothing
  await assert.rejects(reapSessions(db, { now: NOW + SESSION_TTL_S * 10, fence: function* () { throw new Error('lease lost') } }))
  assert.equal((await db.all('SELECT id FROM sessions')).length, 4)
})

bothEngines('last activity is written at most once per window', async ({ db }) => {
  await createPasswordUser(user('A'), db)
  const t = await createSession('A', db)
  const seen = async () => Number((await db.get<{ s: number }>('SELECT last_seen_at AS s FROM sessions WHERE id = ?', [hashToken(t)]))!.s)
  await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [NOW - 10, hashToken(t)])
  await getSessionUser(t, db)
  assert.equal(await seen(), NOW - 10, 'inside the window: no write')
  await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [NOW - SEEN_EVERY_S - 1, hashToken(t)])
  await getSessionUser(t, db)
  assert.ok(await seen() >= NOW)
})

test('device labels are coarse and never the raw header', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'Chrome on macOS')
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS')
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows')
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox on Linux')
  assert.equal(deviceLabel(null), 'Unknown device')
  assert.equal(deviceLabel('curl/8.0'), 'Unknown device')
})

test('sqlite startup: existing sessions get a public id', () => {
  const raw = new Database(':memory:')
  raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER NOT NULL)")
  raw.exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ('h1', 'u', 9999999999), ('h2', 'u', 9999999999)")
  migrateAuth(raw); migrateAuth(raw)
  const ids = (raw.prepare('SELECT public_id FROM sessions').all() as { public_id: string }[]).map(r => r.public_id)
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1])
  for (const id of ids) assert.match(id, /^[a-f0-9]{24}$/)
})
