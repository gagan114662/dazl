import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { POST } from '../../app/api/scan/route.ts'

// #917: real POST /api/scan, in-memory db, network fenced (any provider request throws and is counted), runner never started.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
let fetches = 0
globalThis.fetch = (async (u: unknown) => { fetches++; throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
function setup() { const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db); setScanDb(db); return db }
function as(db: Database.Database) { const id = `U${++n}`; saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setUser({ id, business_name: 'Acme' }) }
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.0.1.${++n}` }, body: JSON.stringify(body) }))
const Q = 'Find independent local businesses in Toronto'
const BASE = { summary: 'Find independent local businesses', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
const long = (k: number) => 'x'.repeat(k)

const CASES: [string, Record<string, unknown>, string, string][] = [
  ['7th exclusion', { exclude: ['chains', 'software vendors', 'franchises', 'government', 'nonprofits', 'agencies', 'healthcare'] }, 'exclude', 'too_many_items'],
  ['5th size', { sizes: ['1-10', '11-50', '51-200', '201-500', '501-1000'] }, 'sizes', 'too_many_items'],
  ['7th location', { where: ['Toronto', 'Ottawa', 'Montreal', 'Calgary', 'Vancouver', 'Halifax', 'Winnipeg'] }, 'where', 'too_many_items'],
  ['item > 160', { signals: [long(161)] }, 'signals', 'item_too_long'],
  ['summary > 300', { summary: long(301) }, 'summary', 'too_long'],
]
for (const [name, patch, field, kind] of CASES) {
  test(`refused before admission: ${name} -> 400 profile_lossy with field detail, no job, no provider request`, async () => {
    const db = setup(); as(db); const before = fetches
    const r = await post({ query: Q, icp: { ...BASE, ...patch } })
    const j = await r.json() as { error: string; loss: { field: string; kind: string }[] }
    assert.equal(r.status, 400); assert.equal(j.error, 'profile_lossy')
    assert.ok(j.loss.some(l => l.field === field && l.kind === kind), JSON.stringify(j.loss))
    assert.equal((db.prepare('SELECT COUNT(*) c FROM scan_jobs').get() as { c: number }).c, 0, 'nothing queued')
    assert.equal(fetches, before, 'no provider request')
  })
}

test('at the caps exactly: accepted and stored whole (6 exclusions, 160-char item, 300-char summary)', async () => {
  const db = setup(); as(db)
  const icp = { ...BASE, summary: long(300), exclude: ['a', 'b', 'c', 'd', 'e', 'f'], signals: [long(160)] }
  const r = await post({ query: Q, icp })
  assert.equal(r.status, 202, JSON.stringify(await r.clone().json()))
  const stored = JSON.parse((db.prepare('SELECT icp FROM scan_jobs').get() as { icp: string }).icp)
  assert.deepEqual(stored.exclude, icp.exclude); assert.deepEqual(stored.signals, icp.signals); assert.equal(stored.summary, icp.summary)
})
