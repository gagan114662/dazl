// The /api/workspace routes through the real handlers and the real session lookup (workspace-session-loader.mjs):
// an invitation link travels from workspace A's owner to B, who joins and switches; and B, acting in their own
// workspace, cannot reach A's members, invitations or workspace through any id they name. Labels below name each
// route the manifest cites this file for. Any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.PUBLIC_BASE_URL = 'https://dazl.test'

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const workspace = await import('../../app/api/workspace/route.ts')
const members = await import('../../app/api/workspace/members/route.ts')
const invitations = await import('../../app/api/workspace/invitations/route.ts')
const accept = await import('../../app/api/workspace/invitations/accept/route.ts')
const sw = await import('../../app/api/workspace/switch/route.ts')
const leaveRoute = await import('../../app/api/workspace/leave/route.ts')

const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const call = async (token: string, fn: () => Promise<Response>) => withJar(new Map([['dazl_session', token]]), async () => { const r = await fn(); return { status: r.status, body: await r.json() as Record<string, unknown> } })
const snapshot = () => JSON.stringify([
  raw.prepare("SELECT * FROM memberships WHERE tenant_id = 'A' ORDER BY rowid").all(),
  raw.prepare("SELECT * FROM invitations WHERE tenant_id = 'A' ORDER BY rowid").all(),
  raw.prepare("SELECT * FROM organizations WHERE id = 'A'").all(),
])
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })

test('invite, join and switch through the routes; nothing of workspace A is reachable from workspace B', async () => {
  for (const id of ['A', 'B', 'C']) await createPasswordUser(user(id))
  raw.prepare('UPDATE users SET email_verified_at = 1').run() // accepting an invitation needs a verified email
  const ta = await createSession('A'), tb = await createSession('B'), tc = await createSession('C')

  // A invites C as an operator; the link carries the token in its fragment
  const inv = await call(ta, () => invitations.POST(req('/api/workspace/invitations', 'POST', { email: 'C@Example.test', role: 'operator' })))
  assert.equal(inv.status, 200)
  const link = String(inv.body.link)
  assert.match(link, /^https:\/\/dazl\.test\/app\/join#t=[a-f0-9]{64}$/)
  const token = link.split('#t=')[1]
  const before = snapshot()

  // B, acting in B, names A's member, A's invitation, A's workspace, A's invitation token
  const label = (s: string) => s
  const attempts: [string, () => Promise<Response>, number][] = [
    [label('PATCH /api/workspace/members'), () => members.PATCH(req('/api/workspace/members', 'PATCH', { member_id: 'A', role: 'viewer' })), 404],
    [label('DELETE /api/workspace/members'), () => members.DELETE(req('/api/workspace/members', 'DELETE', { member_id: 'A' })), 404],
    [label('DELETE /api/workspace/invitations'), () => invitations.DELETE(req('/api/workspace/invitations', 'DELETE', { id: inv.body.id })), 404],
    [label('POST /api/workspace/switch'), () => sw.POST(req('/api/workspace/switch', 'POST', { tenant_id: 'A' })), 404],
    [label('POST /api/workspace/invitations/accept'), () => accept.POST(req('/api/workspace/invitations/accept', 'POST', { token })), 403],
  ]
  for (const [name, fn, want] of attempts) {
    const r = await call(tb, fn)
    assert.equal(r.status, want, `${name}: ${JSON.stringify(r.body)}`)
    assert.equal(snapshot(), before, `${name}: A changed`)
  }
  assert.deepEqual((await call(tb, () => members.GET())).body.members, [{ member_id: 'B', email: 'b@example.test', name: 'B', role: 'owner', created_at: (raw.prepare("SELECT created_at FROM memberships WHERE member_id = 'B'").get() as { created_at: number }).created_at }])
  assert.equal(JSON.stringify((await call(tb, () => invitations.GET())).body.invitations), '[]')

  // C, the invited account, joins: now acting in A as an operator; the link is used up
  const joined = await call(tc, () => accept.POST(req('/api/workspace/invitations/accept', 'POST', { token })))
  assert.deepEqual(joined, { status: 200, body: { ok: true, tenant_id: 'A', role: 'operator', switched: true } })
  const ws = await call(tc, () => workspace.GET())
  assert.deepEqual(ws.body.current, { tenant_id: 'A', role: 'operator' })
  assert.deepEqual((ws.body.workspaces as { tenant_id: string }[]).map(w => w.tenant_id), ['C', 'A'])
  assert.equal((await call(tc, () => accept.POST(req('/api/workspace/invitations/accept', 'POST', { token })))).status, 410)
  // an operator cannot manage members
  assert.equal((await call(tc, () => members.PATCH(req('/api/workspace/members', 'PATCH', { member_id: 'A', role: 'viewer' })))).status, 403)
  // C switches back to their own workspace, and A removes C: C's session in C is untouched
  assert.equal((await call(tc, () => sw.POST(req('/api/workspace/switch', 'POST', { tenant_id: 'C' })))).status, 200)
  assert.equal((await call(ta, () => members.DELETE(req('/api/workspace/members', 'DELETE', { member_id: 'C' })))).status, 200)
  assert.deepEqual((await call(tc, () => workspace.GET())).body.current, { tenant_id: 'C', role: 'owner' })
  // the last owner cannot demote themselves
  assert.deepEqual(await call(ta, () => members.PATCH(req('/api/workspace/members', 'PATCH', { member_id: 'A', role: 'admin' }))), { status: 409, body: { error: 'last_owner' } })
  // A store failure before each side effect: the route fails (500) and nothing changes, the link included
  for (const id of ['D', 'E']) { await createPasswordUser(user(id)); raw.prepare('UPDATE users SET email_verified_at=1 WHERE id=?').run(id) }
  const td = await createSession('D')
  const refuse = (sql: string) => raw.exec(`CREATE TRIGGER dazl_test_refuse ${sql} BEGIN SELECT RAISE(ABORT, 'store refused'); END`)
  const allow = () => raw.exec('DROP TRIGGER dazl_test_refuse')
  const fails = async (name: string, token: string, fn: () => Promise<Response>) => {
    const before = snapshot()
    await assert.rejects(call(token, fn), /store refused/, name)
    allow()
    assert.equal(snapshot(), before, `${name}: a failed write changed A`)
  }
  const invD = await call(ta, () => invitations.POST(req('/api/workspace/invitations', 'POST', { email: 'd@example.test', role: 'operator' })))
  const tokD = String(invD.body.link).split('#t=')[1]
  refuse('BEFORE INSERT ON memberships')
  await fails('accept, membership write fails', td, () => accept.POST(req('/api/workspace/invitations/accept', 'POST', { token: tokD })))
  assert.equal((raw.prepare('SELECT accepted_at FROM invitations WHERE id = ?').get(invD.body.id) as { accepted_at: number | null }).accepted_at, null, 'the link is not used up')
  assert.equal((await call(td, () => accept.POST(req('/api/workspace/invitations/accept', 'POST', { token: tokD })))).status, 200, 'the same link works once the store does')
  refuse('BEFORE UPDATE ON memberships')
  await fails('role change, write fails', ta, () => members.PATCH(req('/api/workspace/members', 'PATCH', { member_id: 'D', role: 'viewer' })))
  refuse('BEFORE DELETE ON memberships')
  await fails('removal, write fails', ta, () => members.DELETE(req('/api/workspace/members', 'DELETE', { member_id: 'D' })))
  const invE = await call(ta, () => invitations.POST(req('/api/workspace/invitations', 'POST', { email: 'e@example.test', role: 'viewer' })))
  refuse('BEFORE INSERT ON invitations')
  await fails('replacing an invitation, write fails: the earlier link is not revoked', ta, () => invitations.POST(req('/api/workspace/invitations', 'POST', { email: 'e@example.test', role: 'admin' })))
  refuse('BEFORE UPDATE ON invitations')
  await fails('revoke, write fails', ta, () => invitations.DELETE(req('/api/workspace/invitations', 'DELETE', { id: invE.body.id })))
  const pointer = () => (raw.prepare('SELECT active_tenant_id AS a FROM sessions WHERE user_id = ?').get('D') as { a: string | null }).a
  assert.equal(pointer(), 'A')
  refuse('BEFORE DELETE ON memberships')
  await fails('leave, write fails: the session still points at A', td, () => leaveRoute.POST(req('/api/workspace/leave', 'POST')))
  assert.equal(pointer(), 'A')
  assert.equal((raw.prepare("SELECT role FROM memberships WHERE tenant_id = 'A' AND member_id = 'D'").get() as { role: string }).role, 'operator')
  // the accept commits, then the session switch fails: the answer says so (switched: false), the membership stands
  const te = await createSession('E')
  const invE2 = await call(ta, () => invitations.POST(req('/api/workspace/invitations', 'POST', { email: 'e@example.test', role: 'viewer' })))
  raw.exec("CREATE TRIGGER dazl_test_refuse BEFORE UPDATE OF active_tenant_id ON sessions WHEN NEW.active_tenant_id = 'A' BEGIN SELECT RAISE(ABORT, 'store refused'); END")
  try {
    const r = await call(te, () => accept.POST(req('/api/workspace/invitations/accept', 'POST', { token: String(invE2.body.link).split('#t=')[1] })))
    assert.deepEqual(r, { status: 200, body: { ok: true, tenant_id: 'A', role: 'viewer', switched: false } })
  } finally { allow() }
  assert.equal((raw.prepare("SELECT role FROM memberships WHERE tenant_id = 'A' AND member_id = 'E'").get() as { role: string }).role, 'viewer')
  assert.deepEqual((await call(te, () => workspace.GET())).body.current, { tenant_id: 'E', role: 'owner' })
  console.log('WORKSPACE MEMBERS ok')
})
