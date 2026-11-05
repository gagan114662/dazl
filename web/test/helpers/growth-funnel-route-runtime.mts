// GET /api/growth/funnel (#404) gate, through the real handler (tenant-route-loader.mjs stubs only the signed-in user):
// signed out 401; a non-owner of the growth workspace 403; any workspace while DAZL_GROWTH_TENANT_ID is unset, or a
// workspace other than the configured one, 404; the growth workspace's owner gets the aggregate report, which carries no
// address or workspace id. Synthetic accounts only; nothing leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

test('growth funnel route is owner-only for the configured growth workspace', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  setScanDb(raw)
  const add = raw.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, 'h', 's', ?)")
  add.run('GROWTH', 'founder@growth.dazl-fixture.co', 1_780_000_000)
  add.run('CUST1', 'buyer@quillfeather.co', 1_780_100_000)
  add.run('OTHER', 'owner@harrowgate.io', 1_780_100_000)
  const { GET } = await import('../../app/api/growth/funnel/route.ts')
  const call = async () => { const res = await GET(new NextRequest('http://localhost/api/growth/funnel')); return { status: res.status, text: await res.text() } }

  delete process.env.DAZL_GROWTH_TENANT_ID
  setUser(null)
  assert.equal((await call()).status, 401)
  setUser({ id: 'GROWTH', business_name: 'dazl' })
  assert.equal((await call()).status, 404, 'unset: the route does not exist')

  process.env.DAZL_GROWTH_TENANT_ID = 'GROWTH'
  for (const role of ['admin', 'operator', 'viewer'] as const) {
    setUser({ id: 'GROWTH', business_name: 'dazl', role, actorId: 'STAFF' })
    assert.equal((await call()).status, 403, role)
  }
  setUser({ id: 'OTHER', business_name: 'Harrowgate' })
  assert.equal((await call()).status, 404, 'another workspace owner')

  setUser({ id: 'GROWTH', business_name: 'dazl' })
  const ok = await call()
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.text)
  assert.equal(body.totals.signups, 2)
  for (const s of ['quillfeather', 'harrowgate', 'CUST1', 'OTHER', 'GROWTH']) assert.ok(!ok.text.includes(s), s)
  console.log('GROWTH ROUTE ok')
})
