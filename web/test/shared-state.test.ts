import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { rateLimit } from '../lib/rate-limit.ts'
import { tryLease } from '../lib/shared/lease.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { pgDb } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { bothEngines } from './helpers/engines.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)

bothEngines('rate limit: fixed window per key, retry-after, then a fresh window', async ({ db }) => {
  const t0 = 1_800_000_000_000
  for (let i = 1; i <= 3; i++) assert.deepEqual(await rateLimit('k', 3, 60_000, db, t0 + i), { ok: true, retryAfterS: 0 })
  assert.deepEqual(await rateLimit('k', 3, 60_000, db, t0 + 10), { ok: false, retryAfterS: 60 })
  assert.equal((await rateLimit('other', 3, 60_000, db, t0 + 10)).ok, true) // keys are independent
  assert.equal((await rateLimit('k', 3, 60_000, db, t0 + 60_001)).ok, true) // window over
  assert.equal((await rateLimit('k', 3, 60_000, db, t0 + 60_002)).ok, true)
})

bothEngines('rate limit: concurrent calls in one process never exceed the limit', async ({ db }) => {
  const rs = await Promise.all(Array.from({ length: 40 }, () => rateLimit('burst', 25, 60_000, db)))
  assert.equal(rs.filter(r => r.ok).length, 25)
}, { pgMax: 8 })

test('rate limit: a broken store fails open and logs, instead of refusing every request', async () => {
  const broken = { kind: 'sqlite', get: () => Promise.reject(new Error('disk I/O error')) } as unknown as Db
  const errs: unknown[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errs.push(a) }
  try { assert.deepEqual(await rateLimit('signin-ip:1.2.3.4', 1, 1000, broken), { ok: true, retryAfterS: 0 }) } finally { console.error = orig }
  assert.equal(errs.length, 1)
  assert.doesNotMatch(JSON.stringify(errs), /1\.2\.3\.4/) // only the key's kind is logged, not the IP or email
})

bothEngines('lease: one holder at a time; release frees it; an expired lease can be taken over', async ({ db }) => {
  const t0 = 1_800_000_000_000
  const a = await tryLease(db, 'tick', 1000, t0)
  assert.ok(a)
  assert.equal(await tryLease(db, 'tick', 1000, t0 + 1), null)
  assert.ok(await tryLease(db, 'other', 1000, t0 + 1)) // names are independent
  await a.release()
  const b = await tryLease(db, 'tick', 1000, t0 + 2)
  assert.ok(b)
  // b's holder crashed: after expiry c takes over, and b's late release must not free c's lease
  const c = await tryLease(db, 'tick', 1000, t0 + 1003)
  assert.ok(c)
  await b.release()
  assert.equal(await tryLease(db, 'tick', 1000, t0 + 1004), null)
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
