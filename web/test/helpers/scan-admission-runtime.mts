import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createQueryJob } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { POST } from '../../app/api/scan/route.ts'

// #913: the real POST /api/scan handler, in-memory db, network fenced, after() captured and never flushed (no runner, no provider call).
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db)
  setScanDb(db); return db
}
function tenant(db: Database.Database) { const id = `T${++n}`; saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); return id }
const req = (body: unknown) => new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.1.0.${++n % 250}` }, body: JSON.stringify(body) })
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'
const jobs = (db: Database.Database, id: string) => db.prepare('SELECT status FROM scan_jobs WHERE user_id = ?').all(id) as { status: string }[]
async function race(id: string, k = 2) {
  setUser({ id, business_name: 'Acme' })
  const rs = await Promise.all(Array.from({ length: k }, () => POST(req({ query: Q }))))
  return Promise.all(rs.map(async r => ({ status: r.status, error: ((await r.json()) as { error?: string }).error })))
}
function seed(db: Database.Database, id: string, k: number, status: string, extra = '') {
  for (let i = 0; i < k; i++) { const jid = createQueryJob(db, id, { query: Q, icp: null, sources: null, seller: null, offer: null, runBudget: null } as never); if (status !== 'pending') db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jid); if (status !== 'pending' && status !== 'running') db.prepare(`UPDATE scan_jobs SET status = ? WHERE id = ?`).run(status, jid); if (extra) db.prepare(`UPDATE scan_jobs SET ${extra.replace(/^, /, '')} WHERE id = ?`).run(jid) }
}

test('concurrent requests for one tenant: exactly one 202, the other scan_active, one job row', async () => {
  const db = setup(); const id = tenant(db)
  const out = await race(id)
  assert.deepEqual(out.map(o => o.status).sort(), [202, 409]); assert.equal(out.find(o => o.status === 409)!.error, 'scan_active')
  assert.equal(jobs(db, id).length, 1)
})

test('five concurrent requests still admit only one', async () => {
  const db = setup(); const id = tenant(db)
  const out = await race(id, 5)
  assert.equal(out.filter(o => o.status === 202).length, 1); assert.equal(jobs(db, id).length, 1)
})

test('at the last monthly slot, concurrent requests cannot exceed the free quota', async () => {
  const db = setup(); const id = tenant(db); seed(db, id, 49, 'done')
  const out = await race(id, 3)
  assert.equal(out.filter(o => o.status === 202).length, 1)
  assert.equal(jobs(db, id).length, 50)
  const again = await race(id, 1); assert.equal(again[0].status, 409) // the admitted one is still pending
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE user_id = ? AND status = 'pending'").run(id); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ? AND status = 'running'").run(id)
  const full = await race(id, 1); assert.equal(full[0].status, 402); assert.equal(full[0].error, 'quota_exceeded'); assert.equal(jobs(db, id).length, 50)
})

test('tenants do not block one another', async () => {
  const db = setup(); const a = tenant(db); const b = tenant(db)
  setUser({ id: a, business_name: 'A' }); const ra = POST(req({ query: Q }))
  setUser({ id: b, business_name: 'B' }); const rb = POST(req({ query: Q }))
  assert.deepEqual([(await ra).status, (await rb).status], [202, 202])
})

test('pending, running and a recent cancel block; completed and an expired cancel allow; CSV jobs are exempt', async () => {
  for (const [status, extra, want] of [['pending', '', 409], ['running', '', 409], ['failed', ", error = 'cancelled', finished_at = CAST(strftime('%s','now') AS INTEGER)", 409], ['done', '', 202], ['failed', ", error = 'cancelled', finished_at = 1", 202]] as const) {
    const db = setup(); const id = tenant(db); seed(db, id, 1, status, extra)
    assert.equal((await race(id, 1))[0].status, want, `${status}${extra}`)
  }
  const db = setup(); const id = tenant(db); seed(db, id, 1, 'pending', ", csv_domain = 'acme.com'")
  assert.equal((await race(id, 1))[0].status, 202, 'a pending CSV import does not hold the manual slot')
})
