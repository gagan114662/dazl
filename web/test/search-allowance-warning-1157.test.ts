// #1157: the matrix account used its whole daily web search allowance (TINYFISH_TENANT_DAILY) and the next scan could not search
// at all. The price estimate shown BEFORE confirm now carries what is left today, and warns under 25 units (about one run).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, SEARCH_ALLOWANCE_LOW, tenantAllowanceLeft } from '../lib/search/tinyfish.ts'
import { searchAllowanceLine } from '../lib/scan/price-estimate.ts'
import { sqliteDb } from '../lib/db/client.ts'

const NOW = Math.floor(Date.parse('2026-11-14T20:00:00Z') / 1000)
const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '200' }
const setup = () => { const raw = new Database(':memory:'); migrateTinyfish(raw); return { raw, db: sqliteDb(raw) } }
const use = (raw: Database.Database, tenant: string, kind: string, n: number, day = '2026-11-14') => raw.prepare('INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT(day, tenant_id, kind) DO UPDATE SET n = n + excluded.n').run(day, tenant, kind, n)

test('what is left today counts this account only, search and fetch together, and is low under 25', async () => {
  const { raw, db } = setup()
  assert.deepEqual(await tenantAllowanceLeft(db, 'A', NOW, env), { left: 200, daily: 200, low: false })
  use(raw, 'A', 'search', 41); use(raw, 'A', 'fetch', 135); use(raw, 'B', 'fetch', 150); use(raw, 'A', 'fetch', 99, '2026-11-13')
  assert.deepEqual(await tenantAllowanceLeft(db, 'A', NOW, env), { left: 24, daily: 200, low: true }, 'the prod matrix account at 176 of 200: one run left')
  use(raw, 'A', 'fetch', 30)
  assert.deepEqual(await tenantAllowanceLeft(db, 'A', NOW, env), { left: 0, daily: 200, low: true }, 'never below zero')
  assert.equal(await tenantAllowanceLeft(db, 'A', NOW, { ...env, TINYFISH_TENANT_DAILY: '400' }).then(r => r!.left), 194, 'the prod setting raised to 400')
  assert.equal(await tenantAllowanceLeft(db, 'A', NOW, {}), null, 'no web search configured: no line')
  assert.equal(SEARCH_ALLOWANCE_LOW, 25)
})

test('the words shown before confirm', () => {
  assert.match(searchAllowanceLine({ left: 0, daily: 200 }), /^Your web search allowance for today is used up \(200 a day\)\. .*free news source.*00:00 UTC/)
  assert.match(searchAllowanceLine({ left: 24, daily: 200 }), /^Only 24 of your 200 web searches and page reads are left today, about one run\./)
})
