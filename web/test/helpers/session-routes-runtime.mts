// Session inventory and revocation through the real routes and the real session lookup (workspace-session-loader.mjs):
// two accounts, several devices each. An account sees and revokes only its own sessions, by public id; a revoked
// session fails on its next request; no response carries a token or a token hash. Labels name each route the
// manifest cites this file for. Any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { scryptSync } from 'node:crypto'
import { createPasswordUser, createSession, getSessionUser, hashToken } from '../../lib/auth-db.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const sessions = await import('../../app/api/auth/sessions/route.ts')
const revokeAll = await import('../../app/api/auth/sessions/revoke-all/route.ts')
const reauth = await import('../../app/api/auth/reauth/route.ts')

const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const call = async (token: string, fn: () => Promise<Response>) => {
  const jar = new Map([['dazl_session', token]])
  return withJar(jar, async () => { const r = await fn(); const text = await r.text(); return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown>, jar } })
}
type Row = { public_id: string; device: string; current: boolean }
const list = async (token: string) => (await call(token, () => sessions.GET())).body.sessions as Row[]
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })

test("an account lists and revokes only its own sessions; revoked sessions fail at once; nothing secret is returned", async () => {
  await createPasswordUser(user('A')); await createPasswordUser(user('B'))
  const a1 = await createSession('A', undefined, { device: 'Chrome on macOS' }), a2 = await createSession('A', undefined, { device: 'Safari on iOS' }), a3 = await createSession('A')
  const b1 = await createSession('B', undefined, { device: 'Firefox on Linux' })
  const secrets = [a1, a2, a3, b1].flatMap(t => [t, hashToken(t)])

  // 'GET /api/auth/sessions': own sessions only, this one marked, no token or hash anywhere in the response
  const r = await call(a1, () => sessions.GET())
  const rows = r.body.sessions as Row[]
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.filter(x => x.current).map(x => x.device), ['Chrome on macOS'])
  for (const s of secrets) assert.ok(!r.text.includes(s), 'no token or token hash in the response')
  const aIds = rows.map(x => x.public_id)
  const [bRow] = await list(b1)

  // 'DELETE /api/auth/sessions': B names A's session -> 404, A's session still works
  const cross = await call(b1, () => sessions.DELETE(req('/api/auth/sessions', 'DELETE', { id: aIds[1] })))
  assert.equal(cross.status, 404)
  assert.ok(await getSessionUser(a2))
  for (const bad of [hashToken(a2), a2, 'nope', '']) assert.equal((await call(b1, () => sessions.DELETE(req('/api/auth/sessions', 'DELETE', { id: bad })))).status, 404)
  // A revokes its Safari session: it fails on its next request
  const safari = rows.find(x => x.device === 'Safari on iOS')!.public_id
  assert.equal((await call(a1, () => sessions.DELETE(req('/api/auth/sessions', 'DELETE', { id: safari })))).status, 200)
  assert.equal(await getSessionUser(a2), null)
  assert.equal((await call(a1, () => sessions.DELETE(req('/api/auth/sessions', 'DELETE', { id: safari })))).status, 404, 'already revoked')
  const rec = raw.prepare('SELECT revoked_by, revoke_reason FROM sessions WHERE public_id = ?').get(safari)
  assert.deepEqual(rec, { revoked_by: 'A', revoke_reason: 'revoked' })

  // 'POST /api/auth/sessions/revoke-all': everywhere else -> only a1 is left; B untouched
  const all = await call(a1, () => revokeAll.POST(req('/api/auth/sessions/revoke-all', 'POST', {})))
  assert.deepEqual(all.body, { ok: true, revoked: 1 })
  assert.ok(await getSessionUser(a1)); assert.equal(await getSessionUser(a3), null)
  assert.deepEqual((await list(b1)).map(x => x.public_id), [bRow.public_id])
  // everywhere, this one included: the cookie is cleared and the session fails
  const out = await call(a1, () => revokeAll.POST(req('/api/auth/sessions/revoke-all', 'POST', { keep_current: false })))
  assert.deepEqual(out.body, { ok: true, revoked: 1 })
  assert.equal(out.jar.has('dazl_session'), false)
  assert.equal(await getSessionUser(a1), null)
  assert.ok(await getSessionUser(b1), "B's session is untouched")
  console.log('SESSION ROUTES ok')
})

test('re-authentication: the right password makes only this session fresh; a wrong one changes nothing', async () => {
  const salt = 'ab'.repeat(16)
  await createPasswordUser({ ...user('P'), password_hash: scryptSync('correct horse battery', salt, 64).toString('hex'), salt })
  const p1 = await createSession('P'), p2 = await createSession('P')
  const old = Math.floor(Date.now() / 1000) - 2 * 60 * 60
  raw.prepare("UPDATE sessions SET authed_at = ? WHERE user_id = 'P'").run(old)
  const authed = (t: string) => (raw.prepare('SELECT authed_at AS a FROM sessions WHERE id = ?').get(hashToken(t)) as { a: number }).a
  assert.equal((await call(p1, () => reauth.GET())).body.fresh, false)
  // 'POST /api/auth/reauth'
  const wrong = await call(p1, () => reauth.POST(req('/api/auth/reauth', 'POST', { password: 'wrong' })))
  assert.equal(wrong.status, 401)
  assert.equal(authed(p1), old)
  const ok = await call(p1, () => reauth.POST(req('/api/auth/reauth', 'POST', { password: 'correct horse battery' })))
  assert.equal(ok.status, 200)
  assert.ok(authed(p1) > old)
  assert.equal(authed(p2), old, "the account's other session is not made fresh")
  assert.deepEqual({ fresh: (await call(p1, () => reauth.GET())).body.fresh, method: (await call(p1, () => reauth.GET())).body.method }, { fresh: true, method: 'password' })
  console.log('REAUTH ok')
})
