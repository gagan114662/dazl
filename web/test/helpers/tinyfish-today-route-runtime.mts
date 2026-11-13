// #1082 ops status: GET /api/internal/tinyfish-today through the REAL route handler (tenant-route-loader maps the
// app's database to this in-memory store). Operator only: no secret configured, or a wrong bearer, is a 404 with no
// data; the right bearer gets today's per-tenant unit counts, never a tenant id.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET } from '../../app/api/internal/tinyfish-today/route.ts'

test('#1082: the operator ops-status route needs the shared secret and shows counts only', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const day = new Date().toISOString().slice(0, 10)
  const ins = raw.prepare('INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, ?, ?, ?)')
  ins.run(day, 'tenant-secret-aaa', 'search', 5); ins.run(day, 'tenant-secret-aaa', 'fetch', 20); ins.run(day, 'tenant-secret-bbb', 'fetch', 7)
  const call = (auth?: string) => GET(new NextRequest('https://dazl.test/api/internal/tinyfish-today', { headers: auth ? { authorization: auth } : {} }))
  delete process.env.AUTOPILOT_TICK_SECRET
  const unset = await call('Bearer undefined')
  assert.equal(unset.status, 404, 'no secret configured: the route does not exist')
  process.env.AUTOPILOT_TICK_SECRET = 's3cret'
  for (const bad of [undefined, 'Bearer wrong!', 'Bearer s3cre', 'Bearer s3crét']) {
    const r = await call(bad)
    assert.equal(r.status, 404, String(bad)); assert.doesNotMatch(await r.text(), /per_tenant|tenant-secret/)
  }
  const ok = await call('Bearer s3cret')
  assert.equal(ok.status, 200)
  const text = await ok.text()
  assert.doesNotMatch(text, /tenant-secret/, 'never a tenant id')
  const j = JSON.parse(text) as { search: { used: number }; fetch: { used: number }; per_tenant: number[] }
  assert.deepEqual(j.per_tenant, [25, 7]); assert.equal(j.search.used, 5); assert.equal(j.fetch.used, 27)
  assert.equal((j as unknown as { active_tenants: number }).active_tenants, 2)
  assert.match(ok.headers.get('cache-control') ?? '', /no-store/)
  console.log('TINYFISH TODAY ROUTE ok')
})
