// #1398: the QA-only request modes ("first5_claude_only_v1", "first5_claude_only_pinned_v2") are not a way into a scan any
// more. A caller sending one gets what every other unknown mode gets (400 unknown_mode) from the REAL POST /api/scan and
// POST /api/scan/estimate handlers, and no job is written. The production Claude Web Search opt-in (mode first5 with the exact
// web_search budget, what the real first-run screen sends) still gets its isolated, pinned, Claude-only job, and an ordinary
// first play still gets an ordinary job. Only the session and the store are swapped (tenant-route-db.ts); nothing calls out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setSellerLine } from './scan-route-auth-stub.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { POST } from '../../app/api/scan/route.ts'
import { POST as ESTIMATE } from '../../app/api/scan/estimate/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db)
  setScanDb(db)
  return db
}
function as(db: Database.Database) {
  const id = `U${++n}`; saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setSellerLine(id, 'Independent compliance consulting'); setUser({ id, business_name: 'Acme' }); return id
}
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.0.1.${++n}` }, body: JSON.stringify(body) })
const jobs = (db: Database.Database) => db.prepare('SELECT run_budget FROM scan_jobs').all() as { run_budget: string | null }[]

const QA_MODES = ['first5_claude_only_v1', 'first5_claude_only_pinned_v2']

test('#1398 POST /api/scan: a QA-only mode is an unknown mode; nothing is queued', async () => {
  for (const mode of QA_MODES) {
    const db = setup(); as(db)
    const r = await POST(req('/api/scan', { query: Q, mode }))
    assert.equal(r.status, 400, mode)
    assert.equal((await r.json() as { error: string }).error, 'unknown_mode', mode)
    assert.equal(jobs(db).length, 0, `${mode}: no job written`)
  }
})

test('#1398 POST /api/scan/estimate: a QA-only mode is priced nowhere (unknown_mode)', async () => {
  for (const mode of QA_MODES) {
    const db = setup(); as(db)
    const r = await ESTIMATE(req('/api/scan/estimate', { query: Q, mode }))
    assert.equal(r.status, 400, mode)
    assert.equal((await r.json() as { error: string }).error, 'unknown_mode', mode)
  }
  // the production opt-in is still priced, Claude-only: no TinyFish row
  const db = setup(); as(db)
  const ok = await ESTIMATE(req('/api/scan/estimate', { query: Q, mode: 'first5', budget: { web_search: 'anthropic_estimated_v1' } }))
  assert.equal(ok.status, 200)
  const { estimate } = await ok.json() as { estimate: { rows: { provider: string }[] } }
  assert.ok(Array.isArray(estimate.rows) && estimate.rows.length > 0)
  assert.equal(estimate.rows.some(r => r.provider === 'TinyFish'), false)
})

test('#1398 the real first-run requests keep working: the Claude Web Search opt-in still gets its isolated Claude-only job; a plain first play stays ordinary', async () => {
  const db = setup(); as(db)
  const opt = await POST(req('/api/scan', { query: Q, mode: 'first5', budget: { web_search: 'anthropic_estimated_v1' } }))
  assert.equal(opt.status, 202)
  const ack = await opt.json() as { provider_policy?: string; execution?: string; web_search_policy?: string }
  assert.deepEqual([ack.provider_policy, ack.execution, ack.web_search_policy], ['claude_only_v1', 'local_once_v1', 'anthropic_estimated_v1'])
  const stored = JSON.parse(jobs(db)[0].run_budget!)
  assert.deepEqual([stored.provider_policy, stored.paid_fallback, stored.credit_enrichment, stored.execution], ['claude_only_v1', false, false, 'local_once_v1'])
  assert.ok(stored.max_usd <= 5)
  const db2 = setup(); as(db2)
  const plain = await POST(req('/api/scan', { query: Q, mode: 'first5' }))
  assert.equal(plain.status, 202)
  assert.equal((await plain.json() as { provider_policy?: string }).provider_policy, undefined)
  assert.equal(JSON.parse(jobs(db2)[0].run_budget!).provider_policy, undefined)
})
