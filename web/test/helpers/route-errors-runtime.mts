// A route's own error records carry the request id proxy.ts gave the request (see test/route-errors.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'
import { newRequestId } from '../../lib/ops/request-log.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture'
const checkout = await import('../../app/api/billing/checkout/route.ts')
const T = 'c'.repeat(32)
globalThis.fetch = (async () => new Response('{"error":{"message":"card for jane@example.com declined"}}', { status: 500 })) as typeof fetch // Stripe fails

test('billing checkout failure: one error record with the request id, the tenant id, no email or key', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  setUser({ id: T, business_name: 'Biz', email: 'jane@example.com' } as never)
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([r => got.push(r)])
  const post = (rid: string) => checkout.POST(new NextRequest('https://dazl.test/api/billing/checkout', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test', 'x-request-id': rid } }))
  try {
    const rid = newRequestId()
    assert.equal((await post(rid)).status, 502)
    assert.equal((await post('jane-4155550134')).status, 502) // not an id proxy.ts gave: dropped
  } finally { restore() }
  assert.equal(got.length, 2)
  assert.deepEqual([got[0].where, got[0].tenant, typeof got[0].request_id], ['/api/billing/checkout', T, 'string'])
  assert.equal('request_id' in got[1], false)
  const s = JSON.stringify(got)
  for (const leak of ['jane', 'sk_test_fixture', '4155550134']) assert.ok(!s.includes(leak), leak)
  console.log('ROUTE_ERRORS_OK')
})
