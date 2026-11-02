// #359 part 2 through the real route handlers: the request flow (GET scope + POST export + POST delete),
// role and fresh-auth gates, confirmation and policy validation, and two-tenant isolation. Any outbound fetch
// fails the test: the lifecycle must never reach outside the store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { seedTenantSqlite, snapshotSqlite } from './tenant-seed-sqlite.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-lifecycle-')), 'app.db')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const lifecycle = await import('../../app/api/tenant/lifecycle/route.ts')
const exportRoute = await import('../../app/api/tenant/lifecycle/export/route.ts')
const deleteRoute = await import('../../app/api/tenant/lifecycle/delete/route.ts')

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${u}`) }) as typeof fetch
const A = 'tenant-aaaa', B = 'tenant-bbbb'
const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })

test('tenant lifecycle routes: request flow, gates, and isolation', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  for (const [t, tag] of [[A, 'ta'], [B, 'tb']] as const) {
    const s = seedTenantSqlite(db, t, tag); assert.deepEqual(s.failed, {}, `every tenant table seeded for ${t}`)
    db.prepare("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?").run(t, t)
    db.prepare("INSERT OR IGNORE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1)").run(t, `${t} workspace`, t)
  }
  const bBefore = snapshotSqlite(db, B)

  // unauthenticated
  setUser(null)
  assert.equal((await lifecycle.GET()).status, 401)
  assert.equal((await exportRoute.POST(req('/api/tenant/lifecycle/export', 'POST', {}))).status, 401)
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', {}))).status, 401)

  // GET: the scope inventory names A's non-empty tables and no deletion yet
  setUser({ id: A, business_name: 'Acme' })
  const g = await lifecycle.GET(); assert.equal(g.status, 200)
  const gj = await g.json()
  assert.equal(gj.tenant, A); assert.ok(gj.tables.leads > 0, 'A has leads'); assert.equal(gj.deletion, null)
  assert.ok(gj.always_retained.includes('audit_events'))

  // export: fresh auth required, then the full export downloads and is audited
  setUser({ id: A, business_name: 'Acme', authedAt: Math.floor(Date.now() / 1000) - 7200 })
  assert.equal((await exportRoute.POST(req('/api/tenant/lifecycle/export', 'POST', {}))).status, 403, 'stale session must re-authenticate')
  setUser({ id: A, business_name: 'Acme' })
  setUser({ id: A, business_name: 'Acme', role: 'viewer' })
  const ev = await exportRoute.POST(req('/api/tenant/lifecycle/export', 'POST', {})) // export is a viewer action, fresh session
  assert.equal(ev.status, 200)
  const ex = JSON.parse(await ev.text())
  assert.equal(ex.format, 'dazl-tenant-export'); assert.equal(ex.tenant, A); assert.ok(ex.tables.leads.length > 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'tenant.export' AND tenant_id = ?").get(A) as { n: number }).n, 1, 'the export is audited')

  // delete: owner-only, fresh, exact confirmation, explicit policy
  setUser({ id: A, business_name: 'Acme', role: 'admin' })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))).status, 403, 'admins do not delete the workspace')
  setUser({ id: A, business_name: 'Acme', authedAt: Math.floor(Date.now() / 1000) - 7200 })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))).status, 403, 'stale session must re-authenticate')
  setUser({ id: A, business_name: 'Acme' })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: 'not-the-tenant', suppressions: 'retain' }))).status, 400, 'the confirmation must name the session tenant')
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A }))).status, 400, 'the opt-out policy choice is required')
  const del = await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))
  const dj = await del.json()
  assert.equal(del.status, 200, JSON.stringify(dj)); assert.equal(dj.state, 'completed')
  assert.ok(dj.retained.suppressions > 0, 'the opt-out list is kept under the chosen policy')
  assert.equal((db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(A) as { n: number }).n, 0, 'A is gone')
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'tenant.deletion_completed' AND tenant_id = ?").get(A) as { n: number }).n, 1, 'the completion is audited')

  // GET after completion: the UI reads state, retained counts and the policy exception
  const g2 = await (await lifecycle.GET()).json()
  assert.equal(g2.deletion.state, 'completed'); assert.equal(g2.deletion.policy.suppressions, 'retain'); assert.ok(g2.deletion.retained.suppressions > 0)

  // B is byte-unchanged throughout, and B can never act on A: its confirmation names B, not A
  assert.deepEqual(snapshotSqlite(db, B), bBefore, "B's rows are byte-equivalent after A's export and deletion")
  setUser({ id: B, business_name: 'Beta' })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'erase' }))).status, 400, "B cannot name A's tenant")
  const bg = await (await lifecycle.GET()).json()
  assert.equal(bg.tenant, B); assert.ok(bg.tables.leads > 0); assert.equal(bg.deletion, null)
})

console.log('TENANT LIFECYCLE ROUTES ok')
