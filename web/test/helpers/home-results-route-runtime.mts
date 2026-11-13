// #1040: the REAL GET /api/home/results handler: 401 signed out, 503 (never zeros) when the store cannot be read,
// 200 no-store with this tenant's counts. Only the session and the Db are replaced (tenant-route-db.ts, setDb).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setUser } from './tenant-route-db.ts'
import { setDb, sqliteDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const route = await import('../../app/api/home/results/route.ts')

test('#1040 GET /api/home/results: 401 signed out, 503 on an unreadable store, 200 no-store with zeros for an empty workspace', async () => {
  setUser(null)
  assert.equal((await route.GET()).status, 401)
  setUser({ id: 'A', business_name: 'Acme' })
  const broken = { kind: 'sqlite', all: async () => { throw new Error('disk I/O error') }, get: async () => { throw new Error('disk I/O error') }, run: async () => { throw new Error('x') } } as unknown as Db
  setDb(broken)
  const r503 = await route.GET()
  assert.equal(r503.status, 503)
  const body503 = await r503.json() as Record<string, unknown>
  assert.equal('tiles' in body503, false, 'an unreadable store never answers counts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setDb(sqliteDb(raw))
  const ok = await route.GET()
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await ok.json() as { tiles: unknown }).tiles, { leads: 0, contacted: 0, replied: 0, interested: 0 })
})
