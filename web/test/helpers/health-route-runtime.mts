// Runs the real health route handlers (see test/health-routes.test.ts). HEALTH_MODE picks the store: 'sqlite' (a
// migrated throwaway file), 'pg-down' (DATABASE_URL on a closed loopback port), or, with DAZL_TEST_PG_URL, 'pg' (a
// fresh schema with every shipped migration) and 'pg-behind' (the same, with the newest migration's record removed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setScanDb } from './tenant-route-db.ts'
import { setErrorSinks } from '../../lib/ops/errors.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { pgDb } from '../../lib/db/client.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

const mode = process.env.HEALTH_MODE
if (mode === 'pg-down') process.env.DATABASE_URL = process.env.HEALTH_DATABASE_URL
if (mode === 'sqlite') { const lite = new Database(':memory:'); migrateAllSqlite(lite); setScanDb(lite) } // as getDb() opens it; pg-down must keep getDb() on DATABASE_URL
const livePg = mode === 'pg' || mode === 'pg-behind'
const schema = livePg ? await freshSchema() : null
if (schema) {
  const admin = pgDb({ connectionString: PG_URL!, searchPath: schema.schema, max: 1 })
  await runPgMigrations(admin.pool)
  if (mode === 'pg-behind') await admin.run('DELETE FROM dazl_schema_migrations WHERE version = (SELECT max(version) FROM dazl_schema_migrations)')
  await admin.close()
  // getDb() opens DATABASE_URL itself; the schema goes in the connection options
  process.env.DATABASE_URL = `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema.schema}`)}`
}
const restore = setErrorSinks([]) // keep the expected pg-down records out of the test output

test(`health routes (${mode})`, async () => {
  const { GET: live } = await import('../../app/api/health/live/route.ts')
  const { GET: health } = await import('../../app/api/health/route.ts')
  const { GET: ready } = await import('../../app/api/health/ready/route.ts')
  const { GET: apiReady } = await import('../../app/api/ready/route.ts')
  // liveness, /api/health and /api/health/live: 200 in every mode, even with the store down; no check runs
  for (const get of [live, health]) {
    const l = await get()
    assert.equal(l.status, 200)
    assert.equal(l.headers.get('cache-control'), 'no-store')
    const body = await l.json()
    assert.deepEqual(Object.keys(body).sort(), ['commit', 'ok'])
    assert.equal(body.ok, true)
  }
  for (const get of [ready, apiReady]) {
    const res = await get()
    const body = await res.json()
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.ok('commit' in body)
    if (mode === 'sqlite') {
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.ok, true)
      assert.equal(body.checks.store.engine, 'sqlite')
      assert.deepEqual(body.checks.schema, { ok: true, skipped: 'sqlite' })
      assert.equal(body.checks.queue.ok, true)
    } else if (mode === 'pg') {
      assert.equal(body.checks.store.engine, 'pg')
      assert.equal(body.checks.store.ok, true, JSON.stringify(body))
      assert.equal(body.checks.schema.ok, true, 'every shipped migration applied')
      assert.equal(body.checks.queue.ok, true, 'the scan queue answers on Postgres')
      assert.equal(body.checks.sqlite.ok, true)
      // Store and schema are ready; while raw-SQLite modules remain, the split check alone holds the instance back
      // (lib/ops/health.ts), so it reports 503 until the port is done, and 200 after.
      const raw = Object.keys((await import('../../lib/db/pg-port-status.ts')).RAW_SQLITE_MODULES).length
      assert.deepEqual(body.checks.split, { ok: raw === 0, raw_sqlite_modules: raw })
      assert.deepEqual([res.status, body.ok], raw === 0 ? [200, true] : [503, false], JSON.stringify(body))
    } else if (mode === 'pg-behind') {
      assert.equal(res.status, 503, JSON.stringify(body))
      assert.equal(body.ok, false)
      assert.equal(body.checks.store.ok, true, 'the store answers')
      assert.deepEqual([body.checks.schema.ok, body.checks.schema.reason], [false, 'behind'], 'a migration this build ships is missing')
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
  if (livePg) { await (await (await import('../../lib/db/client.ts')).getDb()).close(); await schema!.drop() }
  console.log(`HEALTH_ROUTES ${mode}`)
})
