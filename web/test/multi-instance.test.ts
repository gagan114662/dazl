// Several app instances on one Postgres (docs/PLATFORM.md step 3): the shared work queue (lib/queue/db.ts) gives each
// job to exactly one instance, an instance that dies mid-job loses its claim when the lease runs out (re-run once
// elsewhere, or failed past max attempts), and a daily limit counted in Postgres is shared. Each instance is a separate
// process with its own connection pool. The queue contract itself runs on both engines.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { bothEngines } from './helpers/engines.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const T1 = 'a'.repeat(32), T2 = 'b'.repeat(32), T3 = 'c'.repeat(32)
const fixed = { backoff: { baseSeconds: 10, factor: 2, capSeconds: 600, jitter: 0 } }

bothEngines('queue contract: FIFO claim, per-tenant and global caps, fenced complete/fail, retry backoff, dedupe', async ({ db }) => {
  const q = new DbQueue(db, fixed)
  const now = 1_800_000_000
  for (const [i, t] of [[1, T1], [2, T1], [3, T2]] as const) await q.enqueue({ id: `j${i}`, tenantId: t, kind: 'scan', now: now + i })
  assert.deepEqual(await q.enqueue({ tenantId: T3, kind: 'monitor', dedupeKey: 'm1', id: 'd1', now }), { id: 'd1', created: true })
  assert.deepEqual(await q.enqueue({ tenantId: T3, kind: 'monitor', dedupeKey: 'm1', id: 'd2', now }), { id: 'd1', created: false })
  await assert.rejects(q.enqueue({ id: 'j1', tenantId: T1, kind: 'scan', now }), /./) // duplicate id

  const c1 = (await q.claim({ now: now + 10, kinds: ['scan'] }))!
  assert.equal(c1.item.id, 'j1')
  const c2 = (await q.claim({ now: now + 10, kinds: ['scan'] }))! // T1 is at its cap of 1: T2's job is next
  assert.equal(c2.item.id, 'j3')
  assert.equal(await q.claim({ now: now + 10, kinds: ['scan'] }), null)
  assert.equal(await q.claim({ now: now + 10, kinds: ['scan'], maxInFlight: 2 }), null)
  assert.equal(await q.claim({ now: now + 10, kinds: [] }), null) // fail closed

  assert.equal(await q.complete(c1.token), true)
  assert.equal(await q.complete(c1.token), false) // a stale token changes nothing
  assert.equal(await q.fail(c2.token, { now: now + 20, error: 'provider down' }), 'retry')
  const j3 = (await q.get('j3'))!
  assert.deepEqual([j3.status, j3.attempts, j3.notBefore, j3.lastError], ['pending', 1, now + 30, 'provider down'])
  assert.equal(await q.fail(c2.token), 'stale')
  assert.equal(await q.claim({ now: now + 25, kinds: ['scan'], tenants: [T2] }), null) // backoff not over
  const c3 = (await q.claim({ now: now + 30, kinds: ['scan'], tenants: [T2] }))!
  assert.equal(await q.fail(c3.token, { retryable: false, error: 'key_rejected' }), 'failed')
  assert.deepEqual([(await q.depth({ status: 'done' })), (await q.depth({ status: 'failed' })), (await q.depth({ status: 'pending' }))], [1, 1, 2])
})

bothEngines('queue contract: an expired claim goes back to pending (backoff), and fails past max attempts', async ({ db }) => {
  const q = new DbQueue(db, fixed)
  const now = 1_800_000_000
  await q.enqueue({ id: 'r', tenantId: T1, kind: 'scan', now, maxAttempts: 2 })
  const a = (await q.claim({ now, leaseSeconds: 60 }))!
  assert.equal(await q.claim({ now: now + 59 }), null) // still leased
  assert.equal(await q.reapExpired(now + 60), 1)
  assert.equal(await q.complete(a.token), false) // the dead holder's late complete is refused
  assert.deepEqual([(await q.get('r'))!.status, (await q.get('r'))!.notBefore], ['pending', now + 70])
  const b = (await q.claim({ now: now + 70, leaseSeconds: 60 }))!
  assert.equal(b.item.attempts, 2)
  assert.equal(await q.claim({ now: now + 130 }), null) // the reap inside claim fails it: attempts are used up
  assert.deepEqual([(await q.get('r'))!.status, (await q.get('r'))!.lastError], ['failed', 'timeout'])
})

async function sharedSchema() {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 4 })
  await runPgMigrations(db.pool)
  await db.run('CREATE TABLE queue_test_runs (item_id TEXT NOT NULL, instance TEXT NOT NULL)')
  await db.run('CREATE TABLE queue_test_ready (instance TEXT NOT NULL)')
  return { s, db }
}
const instance = (env: Record<string, string>) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT
  return run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/queue-instance.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env: e, encoding: 'utf8', timeout: 120_000 })
}

test('[pg] two instances on one Postgres: each of N jobs runs exactly once, both instances work, the daily limit is shared', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const q = new DbQueue(db)
    const N = 60
    for (let i = 0; i < N; i++) await q.enqueue({ id: `job-${i}`, tenantId: [T1, T2, T3][i % 3], kind: 'scan' })
    const [a, b] = await Promise.all(['A', 'B'].map(name => instance({ QI_NAME: name, QI_MODE: 'drain', QI_SCHEMA: s.schema, QI_TENANT: T1 })))
    const ra = JSON.parse(a.stdout), rb = JSON.parse(b.stdout)
    const runs = await db.all<{ item_id: string; n: number }>('SELECT item_id, count(*)::int AS n FROM queue_test_runs GROUP BY item_id')
    assert.equal(runs.length, N, 'every job ran')
    assert.deepEqual(runs.filter(r => r.n !== 1), [], 'no job ran twice')
    assert.equal(ra.ran + rb.ran, N)
    assert.ok(ra.ran > 0 && rb.ran > 0, `both instances took jobs (A ${ra.ran}, B ${rb.ran})`)
    assert.equal(ra.lateCompletes + rb.lateCompletes, 0)
    assert.equal(await q.depth({ status: 'done' }), N)
    assert.equal(ra.sendsAllowed + rb.sendsAllowed, 12, `one daily cap of 12 across both instances (A ${ra.sendsAllowed}, B ${rb.sendsAllowed})`)
  } finally { await db.close(); await s.drop() }
})

test('[pg] an instance that dies mid-job: its claim is released at lease end and the job runs once more elsewhere, or fails past max attempts', { skip: pgSkip }, async () => {
  const { s, db } = await sharedSchema()
  try {
    const q = new DbQueue(db)
    await q.enqueue({ id: 'retry-me', tenantId: T1, kind: 'scan', maxAttempts: 3 })
    await q.enqueue({ id: 'last-try', tenantId: T2, kind: 'scan', maxAttempts: 1 })
    for (const [victim, tenant] of [['retry-me', T1], ['last-try', T2]]) {
      const crash = await instance({ QI_NAME: `dead-${victim}`, QI_MODE: 'crash', QI_SCHEMA: s.schema, QI_LEASE_S: '3', QI_TENANT: tenant }).catch(e => e as { stdout: string; code: number })
      assert.equal((crash as { code?: number }).code, 1)
      assert.equal(JSON.parse(crash.stdout).crashedOn, victim)
      assert.equal((await q.get(victim))!.status, 'claimed') // held by a process that no longer exists
    }
    await new Promise(r => setTimeout(r, 3200)) // the 3 s leases run out
    await db.run("INSERT INTO queue_test_ready (instance) VALUES ('stand-in')") // the survivor runs alone
    const survivor = JSON.parse((await instance({ QI_NAME: 'B', QI_MODE: 'drain', QI_SCHEMA: s.schema, QI_TENANT: T1 })).stdout)
    assert.equal(survivor.ran, 1)
    const r = (await q.get('retry-me'))!, l = (await q.get('last-try'))!
    assert.deepEqual([r.status, r.attempts], ['done', 2])
    assert.deepEqual([l.status, l.lastError], ['failed', 'timeout'])
    const runs = await db.all<{ item_id: string; instance: string }>('SELECT item_id, instance FROM queue_test_runs ORDER BY item_id, instance')
    assert.deepEqual(runs.map(x => `${x.item_id}@${x.instance}`), ['last-try@dead-last-try', 'retry-me@B', 'retry-me@dead-retry-me'])
  } finally { await db.close(); await s.drop() }
})
