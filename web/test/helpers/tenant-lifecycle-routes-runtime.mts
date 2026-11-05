// #359 part 2 through the real route handlers: the request flow (GET scope + POST export + POST delete),
// covers 'POST /api/tenant/lifecycle/export' for the isolation manifest (both tenants export; each gets only its own),
// role and fresh-auth gates, confirmation and policy validation, and two-tenant isolation. Any outbound fetch
// fails the test: the lifecycle must never reach outside the store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { seedTenantSqlite, snapshotSqlite } from './tenant-seed-sqlite.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { reapplyTombstones, tombstone } from '../../lib/tenant/lifecycle.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-lifecycle-')), 'app.db')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const LEDGER = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-ledger-')), 'tombstones.jsonl')
delete process.env.DAZL_TOMBSTONE_LEDGER

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
  assert.equal(gj.can_delete, true, 'the owner is offered account deletion')

  // export: fresh auth required, then the full export downloads and is audited
  setUser({ id: A, business_name: 'Acme', authedAt: Math.floor(Date.now() / 1000) - 7200 })
  assert.equal((await exportRoute.POST(req('/api/tenant/lifecycle/export', 'POST', {}))).status, 403, 'stale session must re-authenticate')
  setUser({ id: A, business_name: 'Acme' })
  setUser({ id: A, business_name: 'Acme', role: 'viewer' })
  assert.equal((await (await lifecycle.GET()).json()).can_delete, false, 'a viewer is not offered account deletion')
  const ev = await exportRoute.POST(req('/api/tenant/lifecycle/export', 'POST', {})) // export is a viewer action, fresh session
  assert.equal(ev.status, 200)
  const ex = JSON.parse(await ev.text())
  assert.equal(ex.format, 'dazl-tenant-export'); assert.equal(ex.tenant, A); assert.ok(ex.tables.leads.length > 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'tenant.export' AND tenant_id = ?").get(A) as { n: number }).n, 1, 'the export is audited')

  // delete: owner-only, fresh, exact confirmation, explicit policy
  setUser({ id: A, business_name: 'Acme', role: 'admin' })
  assert.equal((await (await lifecycle.GET()).json()).can_delete, false, 'an admin is not offered account deletion')
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))).status, 403, 'admins do not delete the workspace')
  setUser({ id: A, business_name: 'Acme', authedAt: Math.floor(Date.now() / 1000) - 7200 })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))).status, 403, 'stale session must re-authenticate')
  setUser({ id: A, business_name: 'Acme' })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: 'not-the-tenant', suppressions: 'retain' }))).status, 400, 'the confirmation must name the session tenant')
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A }))).status, 400, 'the opt-out policy choice is required')
  // no off-database ledger configured: refused before anything is written (a restore could undo the deletion)
  const off = await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))
  assert.equal(off.status, 503)
  assert.equal(await tombstone(sqliteDb(db), A), undefined, 'no tombstone without the ledger')
  assert.ok(gj.tables.leads === (await (await lifecycle.GET()).json()).tables.leads, 'nothing of A was touched')
  process.env.DAZL_TOMBSTONE_LEDGER = LEDGER
  const backup = db.serialize() // a backup taken before the deletion
  const del = await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'retain' }))
  const dj = await del.json()
  assert.equal(del.status, 200, JSON.stringify(dj)); assert.equal(dj.state, 'completed')
  assert.ok(dj.retained.suppressions > 0, 'the opt-out list is kept under the chosen policy')
  assert.equal((db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(A) as { n: number }).n, 0, 'A is gone')
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'tenant.deletion_completed' AND tenant_id = ?").get(A) as { n: number }).n, 1, 'the completion is audited')

  // the request wrote one off-database ledger line (no tenant data); a resume of a completed deletion adds none
  const lines = readFileSync(LEDGER, 'utf8').split(/\n/).filter(Boolean)
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).deleted_tenant, A); assert.ok(!lines[0].includes('ta~'), 'the ledger line carries no tenant data')
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A }))).status, 200, 'resuming a completed deletion is a no-op')
  assert.equal(readFileSync(LEDGER, 'utf8').split(/\n/).filter(Boolean).length, 1, 'the line is written once')
  // restored backup: the pre-deletion copy has A back and no tombstone; the route-written ledger re-applies it
  const restored = new Database(backup); migrateAllSqlite(restored)
  assert.ok(Number((restored.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(A) as { n: number }).n) === 1, 'the restore brought A back')
  const bRestored = snapshotSqlite(restored, B)
  assert.deepEqual(await reapplyTombstones(sqliteDb(restored), lines), [{ tenant: A, state: 'completed' }])
  assert.equal((restored.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(A) as { n: number }).n, 0, 'A is gone again after the re-application')
  assert.equal((restored.prepare('SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ?').get(A) as { n: number }).n, 0)
  assert.deepEqual(snapshotSqlite(restored, B), bRestored, 'the re-application did not touch B')
  restored.close()

  // GET after completion: the UI reads state, retained counts and the policy exception
  const g2 = await (await lifecycle.GET()).json()
  assert.equal(g2.deletion.state, 'completed'); assert.equal(g2.deletion.policy.suppressions, 'retain'); assert.ok(g2.deletion.retained.suppressions > 0)

  // B is byte-unchanged throughout, and B can never act on A: its confirmation names B, not A
  assert.deepEqual(snapshotSqlite(db, B), bBefore, "B's rows are byte-equivalent after A's export and deletion")
  setUser({ id: B, business_name: 'Beta' })
  assert.equal((await deleteRoute.POST(req('/api/tenant/lifecycle/delete', 'POST', { confirm_tenant: A, suppressions: 'erase' }))).status, 400, "B cannot name A's tenant")
  const bg = await (await lifecycle.GET()).json()
  assert.equal(bg.tenant, B); assert.ok(bg.tables.leads > 0); assert.equal(bg.deletion, null)

  // B's own export is B's data only: nothing of A's - not even A's retained records after the deletion
  const bev = await exportRoute.POST(req('/api/tenant/lifecycle/export', 'POST', {}))
  assert.equal(bev.status, 200)
  const bx = JSON.parse(await bev.text())
  assert.equal(bx.tenant, B, "B's export names B's own tenant")
  assert.equal(bx.tables.users?.[0]?.id, B, "B's export profile is B's own")
  assert.ok(!JSON.stringify(bx).includes('ta~'), "B's export holds nothing of A's rows")
})

console.log('TENANT LIFECYCLE ROUTES ok')
