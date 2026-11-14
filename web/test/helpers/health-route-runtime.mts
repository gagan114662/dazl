// Runs the real health route handlers (see test/health-routes.test.ts). HEALTH_MODE picks the store: 'sqlite' (a
// migrated throwaway file), 'pg-down' (DATABASE_URL on a closed loopback port), or, with DAZL_TEST_PG_URL, 'pg' (a
// fresh schema with every shipped migration) and 'pg-behind' (the same, with the newest migration's record removed).
// 'stats-hang': the SQLite store, with the queue statistics read (DbQueue.stats, the one GROUP BY over work_queue)
// never answering: the mandatory queue SELECT still answers, so the instance stays ready (#430 boundary).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setScanDb, getScanDb } from './tenant-route-db.ts'
import { setErrorSinks } from '../../lib/ops/errors.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { pgDb, setDb, sqliteDb } from '../../lib/db/client.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

const mode = process.env.HEALTH_MODE
// the environment web/docs/DEPLOY.md requires, as test values (no real key); 'env-missing' leaves one out
Object.assign(process.env, { DAZL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), PUBLIC_BASE_URL: 'https://dazl.test',
  STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' })
if (mode === 'env-missing') delete process.env.STRIPE_WEBHOOK_SECRET
// #1089: readiness also needs account mail that can leave the host and a deletion ledger. A fake SMTP server on this
// machine answers the readiness check's real connect; 'mail-port-25' and 'ledger-missing' leave one wrong.
const smtpOpen: import('node:net').Socket[] = []
const smtp = (await import('node:net')).createServer(sock => {
  smtpOpen.push(sock); sock.on('error', () => {})
  sock.write('220 fixture ESMTP\r\n')
  sock.on('data', d => { const line = String(d).trim().toUpperCase(); if (line.startsWith('EHLO') || line.startsWith('HELO')) sock.write('250-fixture\r\n250 OK\r\n'); else if (line.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() } else sock.write('250 OK\r\n') })
})
const smtpPort = await new Promise<number>(r => smtp.listen(0, '127.0.0.1', () => r((smtp.address() as import('node:net').AddressInfo).port)))
const ledgerDir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'dazl-health-ledger-'))
Object.assign(process.env, { SYSTEM_MAIL_SMTP_URL: mode === 'mail-port-25' || mode === 'mail-port-25-required' ? 'smtp://127.0.0.1:25' : `smtp://127.0.0.1:${smtpPort}`, SYSTEM_MAIL_FROM: 'dazl <fixture@example.test>', DAZL_TOMBSTONE_LEDGER: `${ledgerDir}/ledger.jsonl` })
if (mode === 'ledger-missing') delete process.env.DAZL_TOMBSTONE_LEDGER
// reported only by default; 'mail-port-25-required' and 'ledger-missing' turn the operator's switch on
if (mode === 'mail-port-25-required' || mode === 'ledger-missing') process.env.DAZL_READY_REQUIRES_LAUNCH = '1'
delete process.env.DAZL_ENV
if (mode === 'pg-down') process.env.DATABASE_URL = process.env.HEALTH_DATABASE_URL
if (mode === 'sqlite' || mode === 'env-missing' || mode === 'stats-hang' || mode === 'mail-port-25' || mode === 'mail-port-25-required' || mode === 'ledger-missing') { const lite = new Database(':memory:'); migrateAllSqlite(lite); setScanDb(lite) } // as getDb() opens it; pg-down must keep getDb() on DATABASE_URL
if (mode === 'stats-hang') {
  const base = sqliteDb(getScanDb())
  setDb({ ...base, all: (sql, params) => /FROM work_queue GROUP BY kind/.test(sql) ? new Promise(() => {}) : base.all(sql, params) })
}
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
  // the store this instance is configured for: DATABASE_URL -> postgres (pg, pg-behind, pg-down), else sqlite
  const backend = mode === 'sqlite' || mode === 'env-missing' || mode === 'stats-hang' || mode === 'mail-port-25' || mode === 'mail-port-25-required' || mode === 'ledger-missing' ? 'sqlite' : 'postgres'
  const ids = new Set<string>()
  // liveness, /api/health/live: 200 in every mode, even with the store down; no check runs
  const l = await live()
  assert.equal(l.status, 200)
  assert.equal(l.headers.get('cache-control'), 'no-store')
  const lb = await l.json()
  assert.deepEqual(Object.keys(lb).sort(), ['commit', 'db', 'instance', 'ok'])
  assert.deepEqual([lb.ok, lb.db], [true, backend])
  ids.add(lb.instance)
  // /api/health: the commit and whether each configured database answers. SQLite always; Postgres only with
  // DATABASE_URL (not_configured otherwise). 503 when one does not answer, with no error text in the body.
  const h = await health()
  const hb = await h.json()
  assert.equal(h.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(hb).sort(), ['checks', 'commit', 'db', 'instance', 'ok'])
  assert.equal(hb.commit, lb.commit)
  assert.equal(hb.db, backend)
  assert.equal(hb.checks.sqlite.ok, true, JSON.stringify(hb))
  ids.add(hb.instance)
  if (backend === 'sqlite') {
    assert.deepEqual([h.status, hb.ok, hb.checks.postgres], [200, true, { ok: true, skipped: 'not_configured' }])
  } else if (mode === 'pg-down') {
    assert.deepEqual([h.status, hb.ok, hb.checks.postgres.ok], [503, false, false], JSON.stringify(hb))
    assert.ok(!JSON.stringify(hb).includes('ECONNREFUSED') && !JSON.stringify(hb).includes('127.0.0.1:1'), 'no error text or URL')
  } else {
    // reachable Postgres: ok, even when a migration is missing (that is readiness, not reachability)
    assert.deepEqual([h.status, hb.ok, hb.checks.postgres.ok], [200, true, true], JSON.stringify(hb))
  }
  // the mail check never waits: the first probe starts its one background verify; let that land before reading
  await ready(); await (await import('../../lib/ops/launch-checks.ts')).mailCheckSettled()
  for (const get of [ready, apiReady]) {
    const res = await get()
    const body = await res.json()
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.ok('commit' in body)
    assert.equal(body.db, backend)
    ids.add(body.instance)
    if (mode === 'env-missing') {
      assert.equal(res.status, 503, JSON.stringify(body))
      assert.equal(body.checks.store.ok, true, 'the store answers')
      assert.deepEqual(body.checks.env, { ok: false, missing: 1 })
      assert.ok(!JSON.stringify(body).includes('STRIPE'), 'the public body never names the variable')
    } else if (mode === 'mail-port-25') {
      // #1089: mail set to port 25 cannot leave the host. REPORTED, and `ok` unchanged, while the operator has not required it
      assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.ok, true)
      assert.deepEqual(body.checks.mail, { ok: false, reason: 'port_25', port: 25 })
      assert.deepEqual(body.launch, { ok: false, required: false })
      assert.ok(!JSON.stringify(body).includes('127.0.0.1') && !JSON.stringify(body).includes('SYSTEM_MAIL'), 'the public body names no host and no variable')
    } else if (mode === 'mail-port-25-required') {
      // the same deployment once the operator requires it (DAZL_READY_REQUIRES_LAUNCH=1): not ready
      assert.equal(res.status, 503, JSON.stringify(body)); assert.equal(body.ok, false)
      assert.deepEqual(body.checks.mail, { ok: false, reason: 'port_25', port: 25 })
      assert.deepEqual(body.checks.deletion, { ok: true }); assert.deepEqual(body.checks.env, { ok: true, missing: 0 })
      assert.deepEqual(body.launch, { ok: false, required: true })
    } else if (mode === 'ledger-missing') {
      assert.equal(res.status, 503, JSON.stringify(body))
      assert.deepEqual(body.checks.deletion, { ok: false, reason: 'not_configured' }); assert.equal(body.checks.mail.ok, true)
      assert.deepEqual(body.launch, { ok: false, required: true })
      assert.ok(!JSON.stringify(body).includes('TOMBSTONE'), 'the public body never names the variable')
    } else if (mode === 'sqlite') {
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.deepEqual(body.checks.env, { ok: true, missing: 0 })
      assert.equal(body.checks.mail.ok, true, 'the SMTP server answered a real connect'); assert.equal(body.checks.mail.port, smtpPort)
      assert.deepEqual(body.checks.deletion, { ok: true }); assert.deepEqual(body.launch, { ok: true, required: false })
      assert.equal(body.ok, true)
      assert.equal(body.checks.store.engine, 'sqlite')
      assert.deepEqual(body.checks.schema, { ok: true, skipped: 'sqlite' })
      assert.equal(body.checks.queue.ok, true)
      assert.deepEqual(body.queue, { alerts: [] }, 'an empty queue: no alerts')
    } else if (mode === 'stats-hang') {
      // the queue answers; its statistics never do: ready, with the body saying the alerts could not be read
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.ok, true)
      assert.equal(body.checks.queue.ok, true, 'the mandatory queue check passed')
      assert.deepEqual(body.queue, { alerts: null, reason: 'timeout' })
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
  // one id per process, the same on every route; random (12 hex) unless DAZL_INSTANCE_ID names it
  assert.equal(ids.size, 1)
  assert.match([...ids][0], /^[a-f0-9]{12}$/)
  restore()
  if (livePg) { await (await (await import('../../lib/db/client.ts')).getDb()).close(); await schema!.drop() }
  for (const sock of smtpOpen) sock.destroy(); smtp.close()
  console.log(`HEALTH_ROUTES ${mode}`)
})
