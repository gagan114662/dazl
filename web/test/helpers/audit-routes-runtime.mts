// The audit trail through the real routes and the real session lookup (workspace-session-loader.mjs): an owner's
// privileged requests each leave one attributable event in their workspace, with nothing secret in it (a rotated
// Cal.com signing secret, returned to the owner once, never reaches the trail), and a viewer's refused request leaves a
// denied event. Any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, hashToken } from '../../lib/auth-db.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const calcom = await import('../../app/api/settings/calcom/route.ts')
const competitors = await import('../../app/api/settings/competitors/route.ts')
const exportRoute = await import('../../app/api/leads/export/route.ts')
const llmKey = await import('../../app/api/settings/llm-key/route.ts')
const audit = await import('../../app/api/workspace/audit/route.ts')

const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const as = <T,>(token: string, fn: () => Promise<T>) => withJar(new Map([['dazl_session', token]]), fn)
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })

test("privileged requests leave attributable, redacted events; a viewer's refusal leaves a denied one", async () => {
  await createPasswordUser(user('A')); await createPasswordUser(user('V'))
  raw.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('A', 'V', 'viewer', 1)").run()
  const ta = await createSession('A'), tv = await createSession('V')
  raw.prepare("UPDATE sessions SET active_tenant_id = 'A' WHERE id = ?").run(hashToken(tv))

  const rotated = await (await as(ta, () => calcom.POST(req('/api/settings/calcom', 'POST', { action: 'rotate' })))).json() as { secret: string }
  assert.ok(rotated.secret && rotated.secret.length >= 24)
  assert.equal((await as(ta, () => competitors.PUT(req('/api/settings/competitors', 'PUT', { competitors: ['Rival Co'] })))).status, 200)
  assert.equal((await as(ta, () => exportRoute.GET(req('/api/leads/export', 'GET')))).status, 200)
  assert.equal((await as(tv, () => llmKey.DELETE(req('/api/settings/llm-key?vendor=anthropic', 'DELETE')))).status, 403)

  const events = ((await (await as(ta, () => audit.GET(req('/api/workspace/audit', 'GET')))).json()) as { events: { action: string; actor_id: string; decision: string; resource_type: string; summary: Record<string, unknown> }[] }).events
  const seen = events.map(e => `${e.decision} ${e.action} ${e.actor_id} ${e.resource_type}`).reverse()
  assert.deepEqual(seen, ['allowed credential.rotated A calcom', 'allowed settings.changed A competitors', 'allowed export.leads A scan_job', 'denied policy.denied V route'])
  assert.deepEqual(events.find(e => e.action === 'settings.changed')!.summary, { count: 1 })
  assert.deepEqual(events.find(e => e.action === 'policy.denied')!.summary, { needs: 'configure', role: 'viewer' })
  const all = JSON.stringify(raw.prepare('SELECT * FROM audit_events').all())
  assert.ok(!all.includes(rotated.secret), 'the rotated signing secret is not in the trail')
  console.log('AUDIT ROUTES ok')
})
