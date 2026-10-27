// Readiness (lib/ops/health.ts) on both engines, plus the failure cases: the store down, unreachable or hanging, a
// Postgres schema behind this build, the SQLite file failing. Postgres "down" is a closed loopback port: no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { pgDb, type Db } from '../lib/db/client.ts'
import { loadMigrations } from '../lib/db/migrate-pg.ts'
import { readiness } from '../lib/ops/health.ts'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import { bothEngines } from './helpers/engines.ts'

const shipped = () => loadMigrations().map(m => m.version)
const okSqlite = () => new Database(':memory:')

function capturing<T>(f: (got: ErrorRecord[]) => Promise<T>): Promise<T> {
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([r => got.push(r)])
  return f(got).finally(restore)
}

bothEngines('readiness: ready when the store, its schema and the SQLite file answer', async ({ db, kind }) => {
  const r = await readiness({ db: async () => db, sqlite: okSqlite, migrations: shipped })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.checks.store.engine, kind)
  assert.equal(r.checks.store.ok, true)
  assert.deepEqual(kind === 'sqlite' ? r.checks.schema : { ok: r.checks.schema.ok }, kind === 'sqlite' ? { ok: true, skipped: 'sqlite' } : { ok: true })
  assert.equal(r.checks.sqlite.ok, true)
})

bothEngines('readiness: a Postgres schema missing a migration this build ships is not ready', async ({ db, kind }) => {
  if (kind === 'sqlite') return // the SQLite schema is migrated in-process at open
  const r = await readiness({ db: async () => db, sqlite: okSqlite, migrations: () => [...shipped(), 9999] })
  assert.equal(r.ok, false)
  assert.deepEqual({ ...r.checks.schema, ms: 0 }, { ok: false, ms: 0, reason: 'behind' })
})

test('readiness: Postgres unreachable (closed loopback port) is not ready, and the response carries no error text', () => capturing(async got => {
  const db = pgDb({ connectionString: 'postgres://dazl:secret-pw@127.0.0.1:1/none' })
  try {
    const r = await readiness({ db: async () => db, sqlite: okSqlite, migrations: shipped })
    assert.equal(r.ok, false)
    assert.equal(r.checks.store.engine, 'pg')
    assert.deepEqual({ ...r.checks.store, ms: 0 }, { ok: false, ms: 0, reason: 'error', engine: 'pg' })
    assert.deepEqual({ ...r.checks.schema, ms: 0 }, { ok: false, ms: 0, reason: 'error' })
    assert.equal(r.checks.sqlite.ok, true)
    assert.ok(!JSON.stringify(r).includes('ECONNREFUSED') && !JSON.stringify(r).includes('secret-pw'))
    // the cause is recorded for the operator, scrubbed
    assert.equal(got.length, 1)
    assert.equal(got[0].source, 'health')
    assert.equal(got[0].where, 'readiness:store')
    assert.ok(!JSON.stringify(got[0]).includes('secret-pw'))
  } finally { await db.close() }
}))

test('readiness: a store that hangs times out instead of hanging the probe', () => capturing(async got => {
  const hung = { kind: 'pg', get: () => new Promise(() => {}) } as unknown as Db
  const t0 = Date.now()
  const r = await readiness({ db: async () => hung, sqlite: okSqlite, migrations: shipped, timeoutMs: 50 })
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(r.ok, false)
  assert.equal(r.checks.store.ok === false && r.checks.store.reason, 'timeout')
  assert.equal(got[0].error.name, 'Timeout')
}))

test('readiness: opening the store failing, or the SQLite file failing, is not ready', () => capturing(async () => {
  const r1 = await readiness({ db: async () => { throw new Error('bad DATABASE_URL') }, sqlite: okSqlite, migrations: shipped })
  assert.equal(r1.ok, false)
  assert.equal(r1.checks.store.engine, 'unknown')
  const sqliteDb = { kind: 'sqlite', get: async () => ({ x: 1 }) } as unknown as Db
  const closed = new Database(':memory:'); closed.close()
  const r2 = await readiness({ db: async () => sqliteDb, sqlite: () => closed, migrations: shipped })
  assert.equal(r2.ok, false)
  assert.equal(r2.checks.store.ok, true)
  assert.equal(r2.checks.sqlite.ok === false && r2.checks.sqlite.reason, 'error')
}))

// Review repro: synchronous SQLite work cannot be preempted by the timer. The probe waits for it (measured here), and
// reports the check failed once it returns over budget, instead of {ok:true, ms:100}.
test('readiness: a synchronous SQLite check over budget blocks the probe until it returns, then reports timeout', () => capturing(async got => {
  const sqliteDb = { kind: 'sqlite', get: async () => ({ x: 1 }) } as unknown as Db
  const slow = () => ({ prepare: () => ({ get: () => { const end = Date.now() + 100; while (Date.now() < end) { /* busy: holds the thread like a locked SQLite call */ } return 1 } }) })
  const t0 = Date.now()
  const r = await readiness({ db: async () => sqliteDb, sqlite: slow, migrations: shipped, timeoutMs: 10 })
  assert.ok(Date.now() - t0 >= 100, 'the probe could not return before the synchronous call did')
  assert.equal(r.ok, false)
  assert.equal(r.checks.sqlite.ok === false && r.checks.sqlite.reason, 'timeout')
  assert.ok(r.checks.sqlite.ms >= 100)
  assert.equal(r.checks.store.ok, true)
  assert.deepEqual(got.map(g => g.where), ['readiness:sqlite'])
}))
