// Runs the real health route handlers (see test/health-routes.test.ts). HEALTH_MODE picks the store: 'sqlite' (a
// migrated throwaway file) or 'pg-down' (DATABASE_URL on a closed loopback port).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setScanDb } from './tenant-route-db.ts'
import { setErrorSinks } from '../../lib/ops/errors.ts'

const mode = process.env.HEALTH_MODE
if (mode === 'pg-down') process.env.DATABASE_URL = process.env.HEALTH_DATABASE_URL
if (mode === 'sqlite') setScanDb(new Database(':memory:')) // pg-down must keep getDb() on DATABASE_URL
const restore = setErrorSinks([]) // keep the expected pg-down records out of the test output

test(`health routes (${mode})`, async () => {
  const { GET: live } = await import('../../app/api/health/live/route.ts')
  const { GET: health } = await import('../../app/api/health/route.ts')
  const { GET: ready } = await import('../../app/api/health/ready/route.ts')
  const { GET: apiReady } = await import('../../app/api/ready/route.ts')
  const l = await live()
  assert.equal(l.status, 200)
  assert.deepEqual(await l.json(), { ok: true })
  for (const get of [health, ready, apiReady]) {
    const res = await get()
    const body = await res.json()
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.ok('commit' in body)
    if (mode === 'sqlite') {
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.ok, true)
      assert.equal(body.checks.store.engine, 'sqlite')
      assert.deepEqual(body.checks.schema, { ok: true, skipped: 'sqlite' })
    } else {
      assert.equal(res.status, 503, JSON.stringify(body))
      assert.equal(body.ok, false)
      assert.equal(body.checks.store.ok, false)
      assert.equal(body.checks.store.engine, 'pg')
      assert.equal(body.checks.sqlite.ok, true)
      assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'))
    }
  }
  restore()
  console.log(`HEALTH_ROUTES ${mode}`)
})
