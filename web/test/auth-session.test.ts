import assert from 'node:assert/strict'
import { createPasswordUser, createSession, deleteSession, findPasswordUser, getSessionUser, hashToken } from '../lib/auth-db.ts'
import { bothEngines } from './helpers/engines.ts'

const user = { id: 'u1', email: 'a@x.com', name: 'A', business_name: 'Biz', password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }

bothEngines('password user: created once, the same email again reports exists, lookup by email', async ({ db }) => {
  assert.equal(await createPasswordUser(user, db), 'created')
  assert.equal(await createPasswordUser({ ...user, id: 'u2' }, db), 'exists')
  assert.deepEqual(await findPasswordUser('a@x.com', db), { id: 'u1', password_hash: user.password_hash, salt: user.salt })
  assert.equal(await findPasswordUser('nobody@x.com', db), undefined)
})

bothEngines('sessions: a new token signs in, a deleted or expired one does not, only the hash is stored', async ({ db }) => {
  await createPasswordUser(user, db)
  const token = await createSession('u1', db)
  assert.match(token, /^[a-f0-9]{64}$/)
  assert.deepEqual(await getSessionUser(token, db), { id: 'u1', email: 'a@x.com', business_name: 'Biz', actorId: 'u1', tenantId: 'u1', role: 'owner' })
  assert.ok(await db.get('SELECT 1 AS x FROM sessions WHERE id = ?', [hashToken(token)]))
  assert.equal(await db.get('SELECT 1 AS x FROM sessions WHERE id = ?', [token]), undefined)
  assert.equal(await getSessionUser(undefined, db), null)
  assert.equal(await getSessionUser('not-a-token', db), null)
  assert.equal(await getSessionUser('f'.repeat(64), db), null)

  await db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000) - 1, hashToken(token)])
  assert.equal(await getSessionUser(token, db), null)

  const t2 = await createSession('u1', db)
  await deleteSession(t2, db)
  assert.equal(await getSessionUser(t2, db), null)
})
