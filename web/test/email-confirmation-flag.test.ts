// #357 narrowed (review on #608): only an account made by a sign-up that could mail its confirmation link must confirm
// before it signs in or keeps a session. Accounts that existed before (email_confirmation_required = 0 by the column
// default) keep sessions and sign-in exactly as on main, unconfirmed or not, and hit the same ownership gates as on main.
// Nothing is marked verified. Both engines.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CONFIRMED_OR_NOT_REQUIRED, confirmationPending, createPasswordUser, createSession, findPasswordUser, getSessionUser, hasLiveSession, migrateAuth } from '../lib/auth-db.ts'
import { MemberError, acceptInvitation, createInvitation } from '../lib/workspace-members.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'

const base = { name: 'N', business_name: 'Biz', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }
const flag = async (db: Db, id: string) => Number((await db.get<{ f: unknown }>('SELECT email_confirmation_required AS f FROM users WHERE id = ?', [id]))?.f)

bothEngines('a legacy unconfirmed account keeps its session and sign-in lookup as on main; nothing marks it verified', async ({ db }) => {
  assert.equal(await createPasswordUser({ ...base, id: 'L1', email: 'legacy@example.test' }, db), 'created')
  assert.equal(await flag(db, 'L1'), 0, 'no requirement unless the sign-up route asks for it')
  const t = await createSession('L1', db)
  const u = await getSessionUser(t, db)
  assert.ok(u, 'the session works, as on main')
  assert.equal(u.emailVerified, false, 'still unverified: nothing was backfilled')
  assert.equal(await hasLiveSession(t, db), true)
  const row = await findPasswordUser('legacy@example.test', db)
  assert.equal(confirmationPending(row!), false, 'password sign-in is not refused')
  assert.equal(row!.email_verified_at, null)
})

bothEngines('an account made under the requirement has no session until confirmed; then it does', async ({ db }) => {
  await createPasswordUser({ ...base, id: 'N1', email: 'new@example.test', requireConfirmation: true }, db)
  assert.equal(await flag(db, 'N1'), 1)
  const early = await createSession('N1', db)
  assert.equal(await getSessionUser(early, db), null)
  assert.equal(await hasLiveSession(early, db), false)
  assert.equal(confirmationPending((await findPasswordUser('new@example.test', db))!), true)
  await db.run('UPDATE users SET email_verified_at = 1 WHERE id = ?', ['N1'])
  assert.ok(await getSessionUser(early, db), 'confirming opens the existing session too')
  assert.equal(confirmationPending((await findPasswordUser('new@example.test', db))!), false)
})

bothEngines('any non-zero marker counts as required (fail closed); only requireConfirmation === true sets it', async ({ db }) => {
  for (const [id, v] of [['F2', 2], ['F3', -1]] as const) {
    await createPasswordUser({ ...base, id, email: `${id}@example.test` }, db)
    await db.run('UPDATE users SET email_confirmation_required = ? WHERE id = ?', [v, id])
    assert.equal(await getSessionUser(await createSession(id, db), db), null, `marker ${v}`)
    assert.equal(confirmationPending((await findPasswordUser(`${id}@example.test`, db))!), true)
  }
  for (const [id, v] of [['T1', 'yes'], ['T2', 1], ['T3', {}], ['T4', null]] as const) {
    await createPasswordUser({ ...base, id, email: `${id}@example.test`, requireConfirmation: v as never }, db)
    assert.equal(await flag(db, id), 0, `requireConfirmation ${JSON.stringify(v)} is not true`)
  }
  assert.equal(confirmationPending({ email_verified_at: null, email_confirmation_required: '1' }), true, 'a driver string')
  assert.equal(confirmationPending({ email_verified_at: null, email_confirmation_required: 'junk' }), true, 'unparseable: required')
  assert.equal(confirmationPending({ email_verified_at: 5, email_confirmation_required: 1 }), false)
  assert.equal(confirmationPending({ email_verified_at: null, email_confirmation_required: '0' }), false)
})

bothEngines('ownership gates on main still key on a verified email alone: a legacy unconfirmed account cannot accept an invitation, as on main', async ({ db }) => {
  await createPasswordUser({ ...base, id: 'A', email: 'a@example.test' }, db)
  await db.run('UPDATE users SET email_verified_at = 1 WHERE id = ?', ['A'])
  await createPasswordUser({ ...base, id: 'U', email: 'u@example.test' }, db)
  const inv = await createInvitation(db, { tenantId: 'A', actorId: 'A', role: 'owner' }, 'u@example.test', 'admin')
  await assert.rejects(acceptInvitation(db, { actorId: 'U', email: 'u@example.test' }, inv.token), (e: unknown) => e instanceof MemberError && e.code === 'email_unverified')
})

test('the column is additive and re-runnable: rows made before it read 0; running the migrations again changes nothing', () => {
  const d = new Database(':memory:')
  migrateAllSqlite(d)
  d.exec('ALTER TABLE users DROP COLUMN email_confirmation_required')
  d.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('old', 'old@example.test', 'O', 'O', 'h', 's')").run()
  migrateAuth(d)
  migrateAllSqlite(d)
  migrateAuth(d)
  assert.equal((d.prepare("SELECT email_confirmation_required AS f, email_verified_at AS v FROM users WHERE id = 'old'").get() as { f: number; v: unknown }).f, 0)
  assert.equal((d.prepare("SELECT email_verified_at AS v FROM users WHERE id = 'old'").get() as { v: unknown }).v, null, 'not marked verified')
  const n = (d.prepare("SELECT count(*) AS n FROM pragma_table_info('users') WHERE name = 'email_confirmation_required'").get() as { n: number }).n
  assert.equal(n, 1)
  assert.match(CONFIRMED_OR_NOT_REQUIRED, /email_confirmation_required = 0 OR u\.email_verified_at IS NOT NULL/)
})
