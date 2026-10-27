import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { rateLimit } from '../lib/rate-limit.ts'
import { LeaseLost, tryLease } from '../lib/shared/lease.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { pgDb, sqliteDb } from '../lib/db/client.ts'
import { createPasswordUser, findPasswordUser } from '../lib/auth-db.ts'
import type { Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { bothEngines } from './helpers/engines.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)

// Keys carry the engine: the per-process shadow is shared by both engines' runs in this one test process.
bothEngines('rate limit: fixed window per key, retry-after, then a fresh window', async ({ db, kind }) => {
  const t0 = 1_800_000_000_000
  for (let i = 1; i <= 3; i++) assert.deepEqual(await rateLimit(`${kind}:k`, 3, 60_000, db, t0 + i), { ok: true, retryAfterS: 0 })
  assert.deepEqual(await rateLimit(`${kind}:k`, 3, 60_000, db, t0 + 10), { ok: false, retryAfterS: 60 })
  assert.equal((await rateLimit(`${kind}:other`, 3, 60_000, db, t0 + 10)).ok, true) // keys are independent
  assert.equal((await rateLimit(`${kind}:k`, 3, 60_000, db, t0 + 60_001)).ok, true) // window over
  assert.equal((await rateLimit(`${kind}:k`, 3, 60_000, db, t0 + 60_002)).ok, true)
})

bothEngines('rate limit: concurrent calls in one process never exceed the limit', async ({ db, kind }) => {
  const rs = await Promise.all(Array.from({ length: 40 }, () => rateLimit(`${kind}:burst`, 25, 60_000, db)))
  assert.equal(rs.filter(r => r.ok).length, 25)
}, { pgMax: 8 })

// The shared store failing must never remove protection: the per-process limiter takes over (what production ran
// before limits were shared). Each case breaks a real store in a different way, then spends a limit of 2.
async function holdsWhileBroken(db: Db, key: string) {
  const orig = console.error
  const logged: unknown[][] = []
  console.error = (...a: unknown[]) => { logged.push(a) }
  try {
    const r = [await rateLimit(key, 2, 60_000, db), await rateLimit(key, 2, 60_000, db), await rateLimit(key, 2, 60_000, db)]
    assert.deepEqual(r.map(x => x.ok), [true, true, false], 'the limit must still hold while the store is broken')
    assert.ok(r[2].retryAfterS > 0)
  } finally { console.error = orig }
  assert.equal(logged.filter(a => String(a[0]).includes('enforcing this process')).length, 3) // every fallback is logged
  assert.doesNotMatch(JSON.stringify(logged), /example\.test|10\.0\.0\.1/) // only the key's kind is logged
}

test('store read-only (writes refused, reads fine): sign-in lookups still work and the sign-in limits still hold', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  await createPasswordUser({ id: 'u1', email: 'a@example.test', name: 'A', business_name: 'B', password_hash: 'h', salt: 's' }, db)
  raw.pragma('query_only = ON')
  assert.ok(await findPasswordUser('a@example.test', db)) // the route's own read keeps working...
  await holdsWhileBroken(db, 'signin-acct:a@example.test') // ...and so does the brute-force limit
  await holdsWhileBroken(db, 'signin-ip:10.0.0.1')
})

test('store full (SQLITE_FULL): paid-call limits still hold', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.pragma(`max_page_count = ${raw.pragma('page_count', { simple: true })}`)
  const fill = raw.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, 0)')
  // fill every page: big rows first, then small ones into the last gaps
  for (const pad of [200, 0]) assert.throws(() => { for (let i = 0; i < 100_000; i++) fill.run(`fill-${pad}-${i}-${'x'.repeat(pad)}`) }, /full/)
  await holdsWhileBroken(sqliteDb(raw), 'qualify:tenant-1') // app/api/leads/qualify: model calls
})

test('store locked by another writer (SQLITE_BUSY): the limit still holds', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dazl-lock-'))
  try {
    const file = path.join(dir, 'app.db')
    const raw = new Database(file); raw.pragma('journal_mode = WAL'); migrateAllSqlite(raw); raw.pragma('busy_timeout = 0')
    const other = new Database(file)
    other.exec('BEGIN IMMEDIATE')
    try { await holdsWhileBroken(sqliteDb(raw), 'polish:tenant-1') } finally { other.exec('ROLLBACK'); other.close(); raw.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PG unreachable: the limit still holds', async () => {
  const db = pgDb({ connectionString: 'postgres://nobody@127.0.0.1:1/none', max: 1 })
  try { await holdsWhileBroken(db, 'scan:tenant-1') } finally { await db.close() }
})

bothEngines('lease: one holder at a time; release frees it; an expired lease can be taken over; a stale release frees nothing', async ({ db }) => {
  const t0 = 1_800_000_000_000, o = { ttlMs: 1000, stepBudgetMs: 300, heartbeat: false }
  const a = await tryLease(db, 'tick', o, t0)
  assert.ok(a)
  assert.equal(await tryLease(db, 'tick', o, t0 + 1), null)
  assert.ok(await tryLease(db, 'other', o, t0 + 1)) // names are independent
  await a.release()
  const b = await tryLease(db, 'tick', o, t0 + 2)
  assert.ok(b)
  const c = await tryLease(db, 'tick', o, t0 + 1003) // b's holder stopped renewing; after expiry c takes over
  assert.ok(c)
  await b.release()
  assert.equal(await tryLease(db, 'tick', o, t0 + 1004), null)
  await assert.rejects(b.keep(t0 + 1005), LeaseLost) // b learns it lost the lease at its next checkpoint
})

// A long tick: 40 steps of 200 ms (8 s) under a 1 s lease. The holder renews at checkpoints, so another instance trying
// every 50 ms never gets in while it runs, and gets in right after it releases.
bothEngines('lease: work far longer than the TTL never overlaps another holder while it keeps renewing', async ({ db }) => {
  const t0 = 1_800_000_000_000, o = { ttlMs: 1000, stepBudgetMs: 300, heartbeat: false }
  let now = t0
  const a = (await tryLease(db, 'tick', o, now))!
  for (let step = 0; step < 40; step++) {
    await a.keep(now)
    for (let k = 0; k < 4; k++) { now += 50; assert.equal(await tryLease(db, 'tick', o, now), null, `taken over during step ${step}`) }
  }
  await a.release()
  assert.ok(await tryLease(db, 'tick', o, now + 1))
})

// The holder cannot reach the store to renew: it stops starting steps while its confirmed lease still covers a whole
// step, before anyone else can take the lease over, so the last step it ran has ended by the time a new holder starts.
bothEngines('lease: a holder that cannot renew stops before the lease can be taken over', async ({ db }) => {
  const t0 = 1_800_000_000_000, o = { ttlMs: 1000, stepBudgetMs: 300, heartbeat: false }
  // the holder's store connection accepts the acquire (a read-back upsert) but every renewal write fails
  const flaky = { ...db, run: () => Promise.reject(new Error('connection lost')) } as Db
  const a = (await tryLease(flaky, 'tick', o, t0))!
  await a.keep(t0 + 400) // renewal is due and fails, but 600 ms of confirmed lease is left: one more step may start
  await assert.rejects(a.keep(t0 + 701), LeaseLost) // under one step's budget left: no new step
  assert.equal(await tryLease(db, 'tick', o, t0 + 999), null) // nobody else before expiry...
  assert.ok(await tryLease(db, 'tick', o, t0 + 1000)) // ...and at expiry the holder stopped starting steps >= 300 ms ago
})

// Healthy -> outage -> recovery on one key: the decision never forgets an allowance already used (review repro).
test('rate limit: an outage or a recovery never hands back an allowance already used', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const orig = console.error
  console.error = () => {}
  try {
    const ok = async (k: string, limit = 1) => (await rateLimit(k, limit, 60_000, db)).ok
    assert.equal(await ok('transition'), true)
    assert.equal(await ok('transition'), false) // used up while the store is healthy
    raw.pragma('query_only = ON')
    assert.equal(await ok('transition'), false) // the outage does not reset it
    assert.equal(await ok('transition'), false)
    raw.pragma('query_only = OFF')
    assert.equal(await ok('transition'), false) // nor does the recovery
    // flipping the store on and off every call: exactly `limit` calls get through in the window
    let allowed = 0
    for (let i = 0; i < 20; i++) {
      raw.pragma(`query_only = ${i % 2 ? 'ON' : 'OFF'}`)
      if (await ok('flip', 3)) allowed++
    }
    assert.equal(allowed, 3)
    raw.pragma('query_only = OFF')
    // an outage first, then recovery: what was counted during the outage still counts
    raw.pragma('query_only = ON')
    assert.equal(await ok('outage-first', 2), true)
    assert.equal(await ok('outage-first', 2), true)
    await new Promise(r => setTimeout(r, 5)) // the store's own window starts later than this process's
    raw.pragma('query_only = OFF')
    assert.equal(await ok('outage-first', 2), false)
  } finally { console.error = orig }
})

// A step far longer than the TTL, with no checkpoint inside it: the heartbeat keeps the lease, so another instance
// polling all along never gets in; it gets in right after the release.
bothEngines('lease: the heartbeat holds the lease through one step three times longer than the TTL', async ({ db }) => {
  const o = { ttlMs: 300, stepBudgetMs: 100, renewEveryMs: 50 }
  const a = (await tryLease(db, 'tick', o))!
  await a.keep()
  let stolen = 0
  const until = Date.now() + 1000
  while (Date.now() < until) { // the "step": 1 s of work with no keep() call, while another instance polls
    if (await tryLease(db, 'tick', { ...o, heartbeat: false })) stolen++
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(stolen, 0)
  await a.keep() // still the holder after the long step
  await a.release()
  assert.ok(await tryLease(db, 'tick', { ...o, heartbeat: false }))
})

// Two real app instances: separate Node processes over one store. Each instance takes leases for the same 40 job names
// and spends the same rate-limit key; every job must be claimed by exactly one instance and the limit must hold in total.
async function twoInstances(env: Record<string, string>) {
  const child = path.join(import.meta.dirname, 'helpers', 'shared-state-child.mts')
  const go = (order: string) => run(process.execPath, ['--experimental-strip-types', '--no-warnings', child], { env: { ...process.env, ...env, CHILD_ORDER: order } })
  const outs = await Promise.all([go('asc'), go('desc')])
  const res = outs.map(o => JSON.parse(o.stdout) as { claimed: string[]; allowed: number })
  const claimed = res.flatMap(r => r.claimed).sort()
  assert.deepEqual(claimed, Array.from({ length: 40 }, (_, i) => `job-${String(i).padStart(2, '0')}`))
  assert.ok(res.every(r => r.claimed.length > 0), 'both instances should have won some jobs (the test exercises real contention)')
  assert.equal(res[0].allowed + res[1].allowed, 30)
}

test('[sqlite] two app processes on one SQLite file: no job claimed twice, one shared rate limit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dazl-two-'))
  try {
    const file = path.join(dir, 'app.db')
    const raw = new Database(file); raw.pragma('journal_mode = WAL'); migrateAllSqlite(raw); raw.close()
    await twoInstances({ CHILD_SQLITE: file })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[pg] two app processes on one Postgres schema: no job claimed twice, one shared rate limit', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(db.pool)
    await twoInstances({ CHILD_PG_SCHEMA: s.schema })
  } finally { await db.close(); await s.drop() }
})
