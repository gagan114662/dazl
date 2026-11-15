// #1040: the REAL GET /api/home/results handler: 401 signed out, 503 (never zeros) when the store cannot be read,
// 200 no-store with this tenant's counts. Only the session and the Db are replaced (tenant-route-db.ts, setDb).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setUser } from './tenant-route-db.ts'
import { setDb, sqliteDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'
import { NextRequest } from 'next/server'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const route = await import('../../app/api/home/results/route.ts')

test('#1040 GET /api/home/results: 401 signed out, 503 on an unreadable store, 200 no-store with zeros for an empty workspace', async () => {
  setUser(null)
  assert.equal((await route.GET()).status, 401)
  setUser({ id: 'A', business_name: 'Acme' })
  const broken = { kind: 'sqlite', all: async () => { throw new Error('disk I/O error') }, get: async () => { throw new Error('disk I/O error') }, run: async () => { throw new Error('x') } } as unknown as Db
  setDb(broken)
  // the failure is reported (captureError) with this route, the tenant and the request id, before the 503
  const T = 'c'.repeat(32), RID = '3f2a9c4e-1b7d-4e8a-9c0f-5d6e7f8a9b0c'
  setUser({ id: T, business_name: 'Acme' })
  const seen: ErrorRecord[] = []; const restore = setErrorSinks([r => { seen.push(r) }])
  const r503 = await route.GET(new NextRequest('http://dazl.test/api/home/results', { headers: { 'x-request-id': RID } }))
  restore()
  assert.equal(r503.status, 503)
  assert.equal(seen.length, 1, 'one error record')
  assert.deepEqual([seen[0].where, seen[0].method, seen[0].tenant, seen[0].request_id], ['/api/home/results', 'GET', T, RID])
  setUser({ id: 'A', business_name: 'Acme' })
  const body503 = await r503.json() as Record<string, unknown>
  assert.equal('tiles' in body503, false, 'an unreadable store never answers counts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setDb(sqliteDb(raw))
  const ok = await route.GET()
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await ok.json() as { tiles: unknown }).tiles, { leads: 0, contacted: 0, replied: 0, interested: 0 })
  // a sent email and reply reading off (no consent, no account): the route passes that on, so replies are unknown, not 0
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES ('m1', 'A', 'gone', 'x@co.example', 'Hello there', 'A short first email body for the test.', 'sent', ?, ?, 0)").run(Math.floor(Date.now() / 1000) - 86400, Math.floor(Date.now() / 1000) - 86400)
  const off = await (await route.GET()).json() as { reply_reading: boolean; tiles: Record<string, unknown> }
  assert.equal(off.reply_reading, false); assert.deepEqual(off.tiles, { leads: 0, contacted: 1, replied: null, interested: null })
})
