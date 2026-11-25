import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { sharedPool } from '../../lib/llm/spend-pool.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { POST } from '../../app/api/scan/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.DAZL_TRIAL_QA_EXEMPT = 'approved@example.test'
process.env.DAZL_DISCOVER_LANE = '1'
const post = (tenant: string, extra: Record<string, unknown> = {}) => {
  setUser({ id: tenant, business_name: 'Fixture' })
  return POST(new NextRequest('http://localhost/api/scan', { method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost' },
    body: JSON.stringify({ query: 'Businesses opening a new branch', offer: 'Commercial fit-out services', ...extra }) }))
}

test('1725 actual POST refuses exhausted QA before jobs and accepts unrelated account despite spoofed QA fields', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    setScanDb(db)
    for (const [id, email] of [['qa', 'approved@example.test'], ['other', 'other@example.test']]) {
      db.prepare('INSERT INTO users(id,email,password_hash,salt,email_verified_at) VALUES (?,?,?,?,1)').run(id,email,'h','s')
      saveKey(db, id, 'anthropic', 'synthetic-fixture')
    }
    await sharedPool(db, 'qa', { day: 10, month: 100 }).reserve(1)
    const response = await post('qa', { qa: false })
    assert.equal(response.status, 402, JSON.stringify(await response.clone().json()))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM scan_jobs').get() as {n:number}).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM trial_reservations').get() as {n:number}).n, 0)
    db.prepare('DELETE FROM tenant_spend_pools WHERE tenant_id = ?').run('qa')
    const underCap = await post('qa')
    assert.equal(underCap.status, 503, JSON.stringify(await underCap.clone().json()))
    assert.equal((await underCap.json()).error, 'qa_native_cost_unbounded')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM scan_jobs').get() as {n:number}).n, 0)
    const control = await post('other', { qa: true, email: 'approved@example.test' })
    assert.equal(control.status, 202, JSON.stringify(await control.clone().json()))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM scan_jobs').get() as {n:number}).n, 1)
  } finally { db.close() }
})
