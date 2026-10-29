// Invitations, roles, removal, leaving and switching (lib/workspace-members.ts), on both engines.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPasswordUser, createSession, getSessionUser, hashToken } from '../lib/auth-db.ts'
import { INVITE_TTL_S, MemberError, acceptInvitation, changeRole, createInvitation, leave, listInvitations, listMembers, listWorkspaces, removeMember, revokeInvitation, switchWorkspace } from '../lib/workspace-members.ts'
import type { Acting } from '../lib/workspace-members.ts'
import type { Role } from '../lib/workspaces.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'

const code = (c: string) => (e: unknown) => e instanceof MemberError && e.code === c
async function users(db: Db, ...ids: string[]) {
  for (const id of ids) await createPasswordUser({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h', salt: 's' }, db)
}
const add = (db: Db, tenant: string, member: string, role: Role) => db.run('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 1)', [tenant, member, role])
const roleIn = async (db: Db, tenant: string, member: string) => (await db.get<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = ? AND member_id = ?', [tenant, member]))?.role ?? null
const act = (tenantId: string, actorId: string, role: Role): Acting => ({ tenantId, actorId, role })
const me = (id: string) => ({ actorId: id, email: `${id.toLowerCase()}@example.test` })
const OWNER_A = act('A', 'A', 'owner')

bothEngines('an invitation is accepted once, by the invited account only, and stores only the token hash', async ({ db }) => {
  await users(db, 'A', 'B', 'C')
  const inv = await createInvitation(db, OWNER_A, 'b@example.test', 'operator')
  assert.match(inv.token, /^[a-f0-9]{64}$/)
  const row = await db.get<Record<string, unknown>>('SELECT * FROM invitations WHERE id = ?', [inv.id])
  assert.equal(row?.token_hash, createHash('sha256').update(inv.token).digest('hex'))
  assert.ok(!JSON.stringify(row).includes(inv.token))
  assert.ok(!JSON.stringify(await listInvitations(db, 'A')).includes(inv.token))

  await assert.rejects(acceptInvitation(db, me('C'), inv.token), code('wrong_account'))
  assert.equal(await roleIn(db, 'A', 'C'), null)
  assert.deepEqual(await acceptInvitation(db, me('B'), inv.token), { tenantId: 'A', role: 'operator' })
  assert.equal(await roleIn(db, 'A', 'B'), 'operator')
  await assert.rejects(acceptInvitation(db, me('B'), inv.token), code('invalid_invite'), 'replay')
  await assert.rejects(acceptInvitation(db, me('B'), 'f'.repeat(64)), code('invalid_invite'), 'unknown')
  await assert.rejects(acceptInvitation(db, me('B'), 'not-a-token'), code('invalid_invite'))
  assert.deepEqual((await listWorkspaces(db, 'B')).map(w => [w.tenant_id, w.role]), [['B', 'owner'], ['A', 'operator']])
  assert.deepEqual(await listInvitations(db, 'A'), [])
})

bothEngines('expired, revoked and replaced links add nothing; an existing member cannot be invited', async ({ db }) => {
  await users(db, 'A', 'B')
  const now = Math.floor(Date.now() / 1000)
  const old = await createInvitation(db, OWNER_A, 'b@example.test', 'viewer', now - INVITE_TTL_S - 1)
  await assert.rejects(acceptInvitation(db, me('B'), old.token), code('invalid_invite'), 'expired')
  const first = await createInvitation(db, OWNER_A, 'b@example.test', 'viewer')
  const second = await createInvitation(db, OWNER_A, 'b@example.test', 'admin')
  await assert.rejects(acceptInvitation(db, me('B'), first.token), code('invalid_invite'), 'replaced')
  await revokeInvitation(db, OWNER_A, second.id)
  await assert.rejects(acceptInvitation(db, me('B'), second.token), code('invalid_invite'), 'revoked')
  assert.equal(await roleIn(db, 'A', 'B'), null)
  await assert.rejects(createInvitation(db, OWNER_A, 'a@example.test', 'viewer'), code('already_member'))
})

bothEngines('who may invite whom: admins invite up to admin, owners alone invite owners, operators and viewers no one', async ({ db }) => {
  await users(db, 'A', 'D', 'O', 'V')
  await add(db, 'A', 'D', 'admin'); await add(db, 'A', 'O', 'operator'); await add(db, 'A', 'V', 'viewer')
  await createInvitation(db, act('A', 'D', 'admin'), 'x@example.test', 'admin')
  await assert.rejects(createInvitation(db, act('A', 'D', 'admin'), 'y@example.test', 'owner'), code('forbidden'))
  await createInvitation(db, OWNER_A, 'y@example.test', 'owner')
  for (const r of ['operator', 'viewer'] as const) await assert.rejects(createInvitation(db, act('A', r === 'operator' ? 'O' : 'V', r), 'z@example.test', 'viewer'), code('forbidden'))
  const ownerInvite = (await listInvitations(db, 'A')).find(i => i.role === 'owner')!
  await assert.rejects(revokeInvitation(db, act('A', 'D', 'admin'), ownerInvite.id), code('forbidden'))
})

bothEngines('roles and removal: admins never touch owners, the last owner cannot be demoted, removed or leave', async ({ db }) => {
  await users(db, 'A', 'D', 'O', 'B2')
  await add(db, 'A', 'D', 'admin'); await add(db, 'A', 'O', 'operator')
  const admin = act('A', 'D', 'admin')
  await changeRole(db, admin, 'O', 'viewer')
  assert.equal(await roleIn(db, 'A', 'O'), 'viewer')
  await assert.rejects(changeRole(db, admin, 'A', 'admin'), code('forbidden'))
  await assert.rejects(changeRole(db, admin, 'O', 'owner'), code('forbidden'))
  await assert.rejects(removeMember(db, admin, 'A'), code('forbidden'))
  await assert.rejects(changeRole(db, OWNER_A, 'A', 'admin'), code('last_owner'))
  await assert.rejects(leave(db, OWNER_A), code('last_owner'))
  await assert.rejects(removeMember(db, OWNER_A, 'A'), code('forbidden'), 'removing yourself is leave()')
  assert.equal(await roleIn(db, 'A', 'A'), 'owner')
  // a second owner: now either may step down, but not both
  await changeRole(db, OWNER_A, 'D', 'owner')
  await changeRole(db, act('A', 'D', 'owner'), 'A', 'admin')
  await assert.rejects(changeRole(db, act('A', 'D', 'owner'), 'D', 'viewer'), code('last_owner'))
  await assert.rejects(removeMember(db, act('A', 'A', 'admin'), 'D'), code('forbidden'))
  // members of another workspace are not found from this one
  await add(db, 'B2', 'O', 'viewer')
  await assert.rejects(changeRole(db, act('B2', 'B2', 'owner'), 'D', 'viewer'), code('not_found'))
  await assert.rejects(removeMember(db, act('B2', 'B2', 'owner'), 'A'), code('not_found'))
  await removeMember(db, act('A', 'D', 'owner'), 'O')
  assert.equal(await roleIn(db, 'A', 'O'), null)
  assert.equal(await roleIn(db, 'B2', 'O'), 'viewer', 'only this workspace')
  await leave(db, act('A', 'A', 'admin'))
  assert.deepEqual((await listMembers(db, 'A')).map(m => [m.member_id, m.role]), [['D', 'owner']])
})

bothEngines('two owners demoting each other at once: exactly one wins, the workspace keeps an owner', async ({ db }) => {
  await users(db, 'A', 'D')
  await add(db, 'A', 'D', 'owner')
  const r = await Promise.allSettled([changeRole(db, act('A', 'A', 'owner'), 'D', 'admin'), changeRole(db, act('A', 'D', 'owner'), 'A', 'admin')])
  assert.deepEqual(r.map(x => x.status).sort(), ['fulfilled', 'rejected'])
  assert.ok(r.some(x => x.status === 'rejected' && code('last_owner')(x.reason)))
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM memberships WHERE tenant_id = 'A' AND role = 'owner'"))!.n), 1)
}, { pgMax: 4 })

bothEngines('switching: only into a workspace the account belongs to, only for its own session; removal ends it', async ({ db }) => {
  await users(db, 'A', 'B')
  await add(db, 'A', 'B', 'viewer')
  const tb = await createSession('B', db), ta = await createSession('A', db)
  await assert.rejects(switchWorkspace(db, hashToken(tb), 'B', 'nope'), code('not_found'))
  await assert.rejects(switchWorkspace(db, hashToken(ta), 'B', 'A'), code('not_found'), "another account's session")
  await switchWorkspace(db, hashToken(tb), 'B', 'A')
  const u = await getSessionUser(tb, db)
  assert.deepEqual(u && [u.actorId, u.tenantId, u.role, u.business_name], ['B', 'A', 'viewer', 'Biz A'])
  await removeMember(db, OWNER_A, 'B')
  assert.equal(await getSessionUser(tb, db), null)
  assert.equal((await getSessionUser(tb, db))?.tenantId, 'B')
})
