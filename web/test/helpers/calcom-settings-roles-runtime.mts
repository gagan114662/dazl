// #367 review at 0d2ff9d4 (F5): GET /api/settings/calcom says whether the caller may configure (can_configure =
// can(role, 'configure'), the POST route's gate), with real sessions and memberships (workspace-session-loader.mjs), in a
// workspace with no signing secret yet and again with one. Before, the panel inferred it from secret_hidden, which is
// false for everyone while no secret exists, so viewers and operators got controls the POST refuses. Run by
// test/calcom-settings-roles.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, hashToken } from '../../lib/auth-db.ts'
import { getDb } from '../../lib/db/client.ts'
import { rotateSecret } from '../../lib/calcom/index.ts'
import type { Role } from '../../lib/workspaces.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
const route = await import('../../app/api/settings/calcom/route.ts')

test('can_configure follows the role, with and without a signing secret', async () => {
  const role: Record<string, Role> = { A: 'owner', D: 'admin', O: 'operator', V: 'viewer' }
  for (const u of Object.keys(role)) await createPasswordUser(user(u))
  raw.prepare('UPDATE users SET email_verified_at = 1 WHERE id IN (?, ?, ?, ?)').run('A', 'D', 'O', 'V')
  for (const u of ['D', 'O', 'V']) raw.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 1)').run('A', u, role[u])
  const tokens: Record<string, string> = {}
  for (const u of Object.keys(role)) { tokens[u] = await createSession(u); raw.prepare('UPDATE sessions SET active_tenant_id = ? WHERE id = ?').run('A', hashToken(tokens[u])) }
  const get = async (u: string) => withJar(new Map([['dazl_session', tokens[u]]]), async () => {
    const res = await route.GET(new NextRequest('http://localhost/api/settings/calcom', { method: 'GET', headers: { host: 'localhost', origin: 'http://localhost' } }))
    assert.equal(res.status, 200)
    return await res.json() as { configured: boolean; can_configure: unknown; secret_hidden: boolean; now: unknown }
  })
  const seen = async () => Object.fromEntries(await Promise.all(Object.keys(role).map(async u => { const j = await get(u); return [role[u], [j.configured, j.can_configure, j.secret_hidden]] })))
  // no secret yet: secret_hidden is false for every role, so it cannot be the permission signal
  assert.deepEqual(await seen(), { owner: [false, true, false], admin: [false, true, false], operator: [false, false, false], viewer: [false, false, false] })
  await rotateSecret(await getDb(), 'A')
  assert.deepEqual(await seen(), { owner: [true, true, false], admin: [true, true, false], operator: [true, false, true], viewer: [true, false, true] })
  // R4: the server's clock, in epoch seconds, for the panel's held / no-show rule
  const t0 = Math.floor(Date.now() / 1000)
  const { now } = await get('V')
  assert.ok(typeof now === 'number' && Number.isInteger(now) && now >= t0 && now <= Math.floor(Date.now() / 1000), `now = ${String(now)}`)
  console.log('CALCOM ROLES ok')
})
