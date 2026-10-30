// Every session-protected route handler, called with no signed-in user, must refuse and change nothing.
// Runs under tenant-route-loader.mjs: requireUser/getScanDb come from tenant-route-db.ts. Any outbound fetch fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { ROUTES } from '../tenant-isolation-manifest.ts'

const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch

function snapshot(db: Database.Database): string {
  // rate_limits and app_leases are global platform tables (no tenant data); rateLimit() writes there through getDb().
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('rate_limits', 'app_leases') ORDER BY name").all() as { name: string }[]).map(t => t.name)
  return JSON.stringify(tables.map(t => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]))
}

test('every session route refuses an unauthenticated caller and changes nothing', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  // some tenant data to protect
  db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('A', 'a@example.test', 'h', 's')").run()
  db.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 'A', 'pending', 'Acme', 'software', 'Toronto')").run()
  setScanDb(db)
  setUser(null)
  const before = snapshot(db)
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaa'
  const results: string[] = []
  const failures: string[] = []
  for (const r of ROUTES.filter(r => r.auth === 'session')) {
    const mod = await import(`../../app/api/${r.path}/route.ts`) as Record<string, (req: NextRequest, ctx: unknown) => Promise<Response>>
    const handler = mod[r.method]
    assert.equal(typeof handler, 'function', `${r.method} /api/${r.path}: handler exported`)
    const url = `http://localhost/api/${r.path.replace(/\[[a-z]+\]/g, id)}?id=${id}&job_id=${id}&lead_id=${id}`
    const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : JSON.stringify({ id, job_id: id, lead_id: id })
    const req = new NextRequest(url, { method: r.method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body })
    const res = await handler(req, { params: Promise.resolve({ id, lead: id, batch: id }) })
    // Refused = 401, or for browser flows (Gmail OAuth) a redirect to sign-in.
    const refused = res.status === 401 || (res.status >= 300 && res.status < 400 && (res.headers.get('location') ?? '').includes('/sign-in'))
    if (!refused) failures.push(`${r.method} /api/${r.path}: unauthenticated caller got ${res.status}`)
    if (snapshot(db) !== before) failures.push(`${r.method} /api/${r.path}: data changed`)
    results.push(`${r.method} /api/${r.path} ${res.status}`)
  }
  assert.deepEqual(failures, [])
  assert.equal(fetchCalls.length, 0, 'no network call')
  console.log('UNAUTH', results.length)
})
