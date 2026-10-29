// Workspaces and memberships (lib/workspaces.ts, docs/design/workspaces.md): every account owns a personal workspace
// whose id is its user id; a session acts only in a workspace it has a membership row for, read on every request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createPasswordUser, createSession, getSessionUser, hashToken, migrateAuth } from '../lib/auth-db.ts'
import { resolveUser } from '../lib/auth-google.ts'
import { ACTIONS, BACKFILL_SQL, ROLES, can, createPersonalWorkspace } from '../lib/workspaces.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'

const userRow = (id: string, email: string) => ({ id, email, name: id, business_name: `Biz ${id}`, password_hash: `hash-${id}`, salt: `salt-${id}` })
const memberships = (db: Db, id: string) => db.all<{ tenant_id: string; role: string }>('SELECT tenant_id, role FROM memberships WHERE member_id = ? ORDER BY tenant_id', [id])
const legacyUser = (db: Db, id: string) => db.run('INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, id, `Old ${id}`, 'h', 's', 1_700_000_000])
const setActive = (db: Db, token: string, tenant: string | null) => db.run('UPDATE sessions SET active_tenant_id = ? WHERE id = ?', [tenant, hashToken(token)])

bothEngines('signup makes the personal workspace: id = user id, the user its owner; the session acts there', async ({ db }) => {
  assert.equal(await createPasswordUser(userRow('A', 'a@example.test'), db), 'created')
  assert.deepEqual(await db.get('SELECT id, name, kind, created_by FROM organizations WHERE id = ?', ['A']), { id: 'A', name: 'Biz A', kind: 'personal', created_by: 'A' })
  assert.deepEqual(await memberships(db, 'A'), [{ tenant_id: 'A', role: 'owner' }])
  const u = await getSessionUser(await createSession('A', db), db)
  assert.deepEqual(u && { actorId: u.actorId, tenantId: u.tenantId, role: u.role, id: u.id }, { actorId: 'A', tenantId: 'A', role: 'owner', id: 'A' })
  // the same email again creates nothing, workspace included
  assert.equal(await createPasswordUser(userRow('A2', 'a@example.test'), db), 'exists')
  assert.equal(await db.get('SELECT 1 AS x FROM organizations WHERE id = ?', ['A2']), undefined)
})

bothEngines('Google sign-up makes the personal workspace in the same transaction', async ({ db }) => {
  const r = await resolveUser(db, { sub: 'g-1', email: 'g@example.test', name: 'G' })
  assert.ok('user_id' in r && r.created)
  assert.deepEqual(await memberships(db, r.user_id), [{ tenant_id: r.user_id, role: 'owner' }])
  // signing in again adds nothing
  await resolveUser(db, { sub: 'g-1', email: 'g@example.test', name: 'G' })
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM memberships'))!.n), 1)
})

bothEngines('existing accounts: the backfill gives each its own workspace, once, and never re-adds a founder who left', async ({ db }) => {
  await legacyUser(db, 'L1'); await legacyUser(db, 'L2')
  for (const s of BACKFILL_SQL) await db.run(s)
  assert.deepEqual(await memberships(db, 'L1'), [{ tenant_id: 'L1', role: 'owner' }])
  assert.deepEqual(await db.get('SELECT name, kind, created_by, created_at FROM organizations WHERE id = ?', ['L2']), { name: 'Old L2', kind: 'personal', created_by: 'L2', created_at: 1_700_000_000 })
  // L1 gives their workspace away and leaves it: the workspace row stays, so no backfill or sign-in re-adds them
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('L1', 'L2', 'owner', 1)")
  await db.run("DELETE FROM memberships WHERE tenant_id = 'L1' AND member_id = 'L1'")
  for (const s of BACKFILL_SQL) await db.run(s)
  assert.deepEqual(await memberships(db, 'L1'), [])
  assert.equal(await getSessionUser(await createSession('L1', db), db), null)
  assert.equal(await db.tx(t => createPersonalWorkspace(t, 'L1', 'x')), false)
  assert.deepEqual(await memberships(db, 'L1'), [])
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM organizations'))!.n), 2)
})

bothEngines('an account from before workspaces that signs in before any backfill gets its own workspace, nothing else', async ({ db }) => {
  await legacyUser(db, 'L')
  await createPasswordUser(userRow('B', 'b@example.test'), db)
  const u = await getSessionUser(await createSession('L', db), db)
  assert.equal(u?.tenantId, 'L'); assert.equal(u?.role, 'owner')
  assert.deepEqual(await memberships(db, 'L'), [{ tenant_id: 'L', role: 'owner' }])
  assert.equal(await db.tx(t => createPersonalWorkspace(t, 'L', 'again')), false)
})

bothEngines("a chosen workspace counts only while the membership exists: removal ends access on the next request", async ({ db }) => {
  await createPasswordUser(userRow('A', 'a@example.test'), db)
  await createPasswordUser(userRow('B', 'b@example.test'), db)
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at, added_by) VALUES ('A', 'B', 'viewer', 1, 'A')")
  const tb = await createSession('B', db)
  assert.equal((await getSessionUser(tb, db))?.tenantId, 'B', 'default: the personal workspace')
  await setActive(db, tb, 'A')
  const inA = await getSessionUser(tb, db)
  assert.deepEqual(inA && [inA.actorId, inA.tenantId, inA.role], ['B', 'A', 'viewer'])
  await db.run("DELETE FROM memberships WHERE tenant_id = 'A' AND member_id = 'B'")
  assert.equal(await getSessionUser(tb, db), null, 'the request meant for A fails; it does not run in another workspace')
  assert.equal((await db.get<{ a: string | null }>('SELECT active_tenant_id AS a FROM sessions WHERE id = ?', [hashToken(tb)]))?.a, null)
  assert.equal((await getSessionUser(tb, db))?.tenantId, 'B', 'then back to their own')
})

bothEngines('a session pointed at a workspace it has no membership in gets nothing', async ({ db }) => {
  await createPasswordUser(userRow('A', 'a@example.test'), db)
  await createPasswordUser(userRow('B', 'b@example.test'), db)
  const tb = await createSession('B', db)
  for (const forged of ['A', 'nope', '']) {
    await setActive(db, tb, forged)
    assert.equal(await getSessionUser(tb, db), null, forged)
  }
  assert.deepEqual(await memberships(db, 'B'), [{ tenant_id: 'B', role: 'owner' }])
})

bothEngines('a member with no personal workspace acts in their oldest membership', async ({ db }) => {
  await createPasswordUser(userRow('A', 'a@example.test'), db)
  await createPasswordUser(userRow('C', 'c@example.test'), db)
  await createPasswordUser(userRow('B', 'b@example.test'), db)
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('C', 'B', 'admin', 20), ('A', 'B', 'operator', 10)")
  await db.run("DELETE FROM memberships WHERE tenant_id = 'B' AND member_id = 'B'")
  const u = await getSessionUser(await createSession('B', db), db)
  assert.deepEqual(u && [u.tenantId, u.role], ['A', 'operator'])
})

bothEngines('the schema refuses a role outside the four', async ({ db }) => {
  await assert.rejects(db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('A', 'B', 'superuser', 1)"))
})

test('roles: viewers read and export only; operators also launch and send; admins configure and manage members; owners alone bill and manage owners', () => {
  const allowed = Object.fromEntries(ROLES.map(r => [r, (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).filter(a => can(r, a))]))
  assert.deepEqual(allowed, {
    viewer: ['read', 'export'],
    operator: ['read', 'export', 'operate', 'send'],
    admin: ['read', 'export', 'operate', 'send', 'configure', 'members'],
    owner: ['read', 'export', 'operate', 'send', 'configure', 'members', 'billing', 'owners'],
  })
  for (const bad of [null, undefined, '', 'Owner', 'superuser', 'toString']) assert.equal(can(bad as never, 'read'), false, String(bad))
})

test('sqlite startup: migrateAuth backfills existing users and is idempotent', () => {
  const raw = new Database(':memory:')
  raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER NOT NULL)")
  raw.exec("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES ('old', 'old@example.test', 'h', 's', 5)")
  migrateAuth(raw); migrateAuth(raw)
  assert.deepEqual(raw.prepare('SELECT tenant_id, member_id, role, created_at FROM memberships').all(), [{ tenant_id: 'old', member_id: 'old', role: 'owner', created_at: 5 }])
  assert.deepEqual(raw.prepare('SELECT id, name, kind FROM organizations').all(), [{ id: 'old', name: '', kind: 'personal' }])
})

test('the PG migration backfills with exactly the SQL the SQLite startup runs', () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const mig = norm(readFileSync(new URL('../lib/db/migrations/pg/0013_workspaces.sql', import.meta.url), 'utf8'))
  for (const s of BACKFILL_SQL) assert.ok(mig.includes(norm(s) + ';'), norm(s))
})
