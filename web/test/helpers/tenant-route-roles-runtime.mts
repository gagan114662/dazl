// Every session route handler, called by a member whose role does not allow the handler's action
// (test/tenant-isolation-manifest.ts `role`, lib/workspaces.ts ACTIONS), must refuse with 403 and change nothing. A
// viewer's reads still work. The one write a refusal may make is the audit trail's own denied event (lib/audit.ts),
// held to exactly that below. Runs under tenant-route-loader.mjs: requireUser/getScanDb come from tenant-route-db.ts.
// Any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { ROLES, can } from '../../lib/workspaces.ts'
import { ROUTES } from '../tenant-isolation-manifest.ts'

const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch

function snapshot(db: Database.Database): string {
  // rate_limits and app_leases are global platform tables (no tenant data); rateLimit() writes there through getDb().
  // audit_events is checked on its own: a refusal may append its denied event, and nothing else.
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('rate_limits', 'app_leases', 'audit_events') ORDER BY name").all() as { name: string }[]).map(t => t.name)
  return JSON.stringify(tables.map(t => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]))
}

const id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const call = async (r: { path: string; method: string }) => {
  const mod = await import(`../../app/api/${r.path}/route.ts`) as Record<string, (req: NextRequest, ctx: unknown) => Promise<Response>>
  const url = `http://localhost/api/${r.path.replace(/\[[a-z]+\]/g, id)}?id=${id}&job_id=${id}&lead_id=${id}`
  const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : JSON.stringify({ id, job_id: id, lead_id: id, action: 'send' })
  const req = new NextRequest(url, { method: r.method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body })
  return mod[r.method](req, { params: Promise.resolve({ id, lead: id, batch: id }) })
}

test('a member whose role does not allow a route is refused with 403 and changes nothing; viewers still read', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  // workspace A, with some data to protect; the caller is member M of A
  db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('A', 'a@example.test', 'h', 's'), ('M', 'm@example.test', 'h', 's')").run()
  db.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, 'A', 'pending', 'Acme', 'software', 'Toronto')").run(id)
  setScanDb(db)
  const before = snapshot(db)
  const failures: string[] = []
  let refused = 0, reads = 0
  const deniedEvents: string[] = []
  for (const role of ROLES) {
    setUser({ id: 'A', actorId: 'M', role, business_name: 'Acme' })
    for (const r of ROUTES) {
      if (r.auth !== 'session' || can(role, r.role)) continue
      const res = await call(r)
      if (res.status !== 403) failures.push(`${role} ${r.method} /api/${r.path}: got ${res.status}, needs ${r.role}`)
      else assert.deepEqual(await res.json(), { error: 'forbidden', needs: r.role })
      if (snapshot(db) !== before) failures.push(`${role} ${r.method} /api/${r.path}: data changed`)
      // the same member's repeated refusals within a minute are recorded once (route.ts, audit-denied rate limit)
      if (r.path === 'workspace/audit' && deniedEvents.length === 0) deniedEvents.push(`A M audit.read denied ${role}`)
      refused++
    }
  }
  // positive control: the same viewer passes the role check on every read-only GET
  setUser({ id: 'A', actorId: 'M', role: 'viewer', business_name: 'Acme' })
  for (const r of ROUTES) {
    if (r.auth !== 'session' || r.method !== 'GET' || r.role !== 'read') continue
    // a read that gets past the role check may still fail later on this bare fixture (e.g. after() outside a request);
    // only a 403 counts as refused
    const status = await call(r).then(res => res.status, () => 'threw')
    if (status === 403) failures.push(`viewer GET /api/${r.path}: refused a read`)
    reads++
  }
  assert.deepEqual(failures, [])
  // the only audit rows are the refused audit reads' own denied events, in the workspace that was asked for
  const trail = db.prepare('SELECT tenant_id, actor_id, action, decision, summary FROM audit_events ORDER BY at, seq').all() as { tenant_id: string; actor_id: string; action: string; decision: string; summary: string }[]
  assert.deepEqual(trail.map(e => `${e.tenant_id} ${e.actor_id} ${e.action} ${e.decision} ${JSON.parse(e.summary).role}`), deniedEvents)
  assert.ok(deniedEvents.length > 0)
  assert.equal(fetchCalls.length, 0, 'no network call')
  console.log('ROLES', refused, reads)
})
