// Multi-instance safety (docs/PLATFORM.md, "In-memory state"): two app instances, each a separate process with its own
// pool, on one Postgres at the same time (test/helpers/multi-instance-app.mts). Nothing they must agree on may live in
// one process's memory:
//   - Stripe webhook idempotency: the same signed event, delivered 8 times to each instance at once, is applied once
//   - rate limits: 15 failed sign-ins from one IP on each instance share the one per-IP limit of 20
//   - jobs: 30 queued jobs drained by both instances are each processed exactly once
//   - TinyFish's server-wide minute window (6 a minute) and its breaker hold across instances
// Stubbed throughout: no network call, no provider, no Stripe; the event is a fixture signed with a test secret.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { tfSearch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const web = fileURLToPath(new URL('../', import.meta.url))
const T = 'c'.repeat(32)

const instance = async (schema: string, name: string, webhook: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, MI_SCHEMA: schema, MI_NAME: name, MI_TENANT: T, MI_WEBHOOK: webhook }
  delete env.NODE_TEST_CONTEXT
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', './test/helpers/multi-instance-app.mts'],
    { cwd: web, env, encoding: 'utf8', timeout: 180_000 })
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { name: string; webhook: string[]; signins: number[]; processed: number; tinyfishCalls: number; startedAt: number; finishedAt: number }
}

test('[pg] two app instances on one Postgres: a webhook applied once, one shared rate limit, each job processed once, one TinyFish minute window', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(db.pool)
    await db.run('CREATE TABLE mi_ready (instance TEXT NOT NULL)')
    await db.run('CREATE TABLE mi_processed (job_id TEXT NOT NULL, instance TEXT NOT NULL)')
    await db.run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, 'owner@example.test', 'h', 's', 'Co', 1)", [T])
    const q = new DbQueue(db)
    for (let i = 0; i < 30; i++) await q.enqueue({ id: `mijob${String(i).padStart(19, '0')}`, tenantId: T, kind: 'mi-job' })
    const webhook = 'whsec_test' + randomBytes(8).toString('hex')

    const [a, b] = await Promise.all([instance(s.schema, 'A', webhook), instance(s.schema, 'B', webhook)])
    assert.ok(a.startedAt < b.finishedAt && b.startedAt < a.finishedAt, `the instances ran at the same time (A ${a.startedAt}-${a.finishedAt}, B ${b.startedAt}-${b.finishedAt})`)

    // Stripe: 16 deliveries of one event across both instances, applied exactly once
    const results = [...a.webhook, ...b.webhook]
    assert.deepEqual([results.filter(r => r === 'applied').length, results.filter(r => r === 'duplicate').length], [1, 15], results.join(','))
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events'))!.n), 1)
    assert.deepEqual(await db.get('SELECT plan, subscription_status FROM tenant_plans WHERE tenant_id = ?', [T]), { plan: 'pro', subscription_status: 'active' })

    // rate limit: 30 sign-in attempts from one IP across both instances, one shared limit of 20
    const statuses = [...a.signins, ...b.signins]
    assert.deepEqual([statuses.filter(x => x === 401).length, statuses.filter(x => x === 429).length], [20, 10], statuses.join(','))
    assert.ok(a.signins.includes(429) || b.signins.includes(429))

    // jobs: every queued job processed once, by one instance
    const done = await db.all<{ job_id: string; n: number }>('SELECT job_id, count(*)::int AS n FROM mi_processed GROUP BY job_id')
    assert.equal(done.length, 30)
    assert.deepEqual(done.filter(r => r.n !== 1), [], 'no job processed twice')
    assert.equal(a.processed + b.processed, 30)
    assert.ok(a.processed > 0 && b.processed > 0, `both instances processed jobs (A ${a.processed}, B ${b.processed})`)

    // TinyFish: 16 searches across both instances under one server-wide window of 6 a minute
    assert.equal(a.tinyfishCalls + b.tinyfishCalls, 6, `A ${a.tinyfishCalls} + B ${b.tinyfishCalls}`)
  } finally { await db.close(); await s.drop() }
})

test('[pg] the TinyFish breaker one instance trips stops the other instance too', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const one = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  const two = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(one.pool)
    const now = 1_793_000_000
    const env = { TINYFISH_API_KEY: 'tf-test' }
    let calls = 0
    const limited = (async () => { calls++; return new Response('{}', { status: 429 }) }) as unknown as typeof fetch
    const fine = (async () => { calls++; return new Response(JSON.stringify({ results: [] }), { status: 200 }) }) as unknown as typeof fetch
    assert.deepEqual(await tfSearch(one, T, 'first query here', {}, { searches: 0 }, { env, fetchImpl: limited, now }), { ok: false, reason: 'rate' })
    await resetTinyfishState() // both handles are in this process: drop its own memory, as a second process would not have it
    assert.deepEqual(await tfSearch(two, T, 'second query here', {}, { searches: 0 }, { env, fetchImpl: fine, now: now + 30 }), { ok: false, reason: 'rate' }, 'the other instance is held by the breaker')
    assert.equal(calls, 1)
    assert.ok((await tfSearch(two, T, 'third query here', {}, { searches: 0 }, { env, fetchImpl: fine, now: now + 61 })).ok, 'the breaker lifts after its minute')
    assert.equal(calls, 2)
  } finally { await one.close(); await two.close(); await s.drop() }
})
