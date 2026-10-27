// Lease fencing (lib/shared/lease.ts): worker A holds a lease and writes, then pauses; its lease expires and worker B
// takes it over (generation + 1); A resumes and every write it attempts is refused, while B's go through.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { tryLease, LeaseLost, StaleLeaseWrite, FENCE_SQL } from '../lib/shared/lease.ts'
import type { Lease } from '../lib/shared/lease.ts'
import { sqliteDb, pgDb, toPgPlaceholders } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { getPlan, setPlan } from '../lib/plans.ts'
import { bothEngines } from './helpers/engines.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const T0 = 1_800_000_000_000
function clocked() {
  const c = { now: T0 }
  return { c, o: { ttlMs: 1000, stepBudgetMs: 300, heartbeat: false, clock: () => c.now } }
}
const effect = (db: Db, l: Lease, who: string, n: number) => db.tx(function* (t) {
  yield* l.fence(t)
  yield* t.run('INSERT INTO fenced_effects (who, n) VALUES (?, ?)', [who, n])
})

bothEngines('A pauses, B takes over, A resumes: every write A attempts is refused; B writes', async ({ db }) => {
  await db.run('CREATE TABLE fenced_effects (who TEXT NOT NULL, n INTEGER NOT NULL)')
  const { c, o } = clocked()
  const a = (await tryLease(db, 'job', o))!
  assert.equal(a.generation, 1)
  await effect(db, a, 'A', 1) // A holds the lease: its write goes through
  assert.equal(await tryLease(db, 'job', o), null)

  c.now = T0 + 1500 // A is paused past its expiry (no heartbeat, no keep)
  const b = (await tryLease(db, 'job', o))!
  assert.equal(b.generation, 2) // takeover bumps the fencing token

  // A resumes, unaware: its writes are refused and leave nothing behind
  await assert.rejects(effect(db, a, 'A', 2), StaleLeaseWrite)
  await assert.rejects(effect(db, a, 'A', 3), StaleLeaseWrite)
  await effect(db, b, 'B', 1)
  assert.deepEqual((await db.all<{ who: string; n: number }>('SELECT who, n FROM fenced_effects ORDER BY who, n')).map(r => `${r.who}${Number(r.n)}`), ['A1', 'B1'])
  await assert.rejects(a.keep(), LeaseLost)
  // A's late release cannot free B's lease
  await a.release()
  assert.equal(await tryLease(db, 'job', o), null)
  await effect(db, b, 'B', 2)
})

bothEngines('an expired lease nobody has taken over yet also refuses its holder\'s writes', async ({ db }) => {
  await db.run('CREATE TABLE fenced_effects (who TEXT NOT NULL, n INTEGER NOT NULL)')
  const { c, o } = clocked()
  const a = (await tryLease(db, 'job', o))!
  c.now = T0 + 1001
  await assert.rejects(effect(db, a, 'A', 1), StaleLeaseWrite)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM fenced_effects'))!.n), 0)
})

// The tick's modules use the raw SQLite handle: every write through the fenced view is checked, inside the module's own
// transactions too; reads pass. Uses real module writers (setPlan) and raw prepare/exec.
test('[sqlite] fenced raw handle: a module\'s writes are refused once the lease is lost; reads still work', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const { c, o } = clocked()
  const a = (await tryLease(db, 'internal-tick', o))!
  const view = a.fenceSqlite(raw)
  setPlan(view, 'tenant-1', 'pro') // a real module write while A holds the lease
  view.exec("INSERT INTO rate_limits (key, count, reset_at) VALUES ('k1', 1, 0)")
  view.transaction(() => { view.prepare("INSERT INTO rate_limits (key, count, reset_at) VALUES ('k2', 1, 0)").run() })()

  c.now = T0 + 1500
  const b = (await tryLease(db, 'internal-tick', o))!
  assert.ok(b)
  assert.throws(() => setPlan(view, 'tenant-1', 'free'), StaleLeaseWrite)
  assert.throws(() => view.exec("INSERT INTO rate_limits (key, count, reset_at) VALUES ('k3', 1, 0)"), StaleLeaseWrite)
  assert.throws(() => view.transaction(() => { view.prepare("INSERT INTO rate_limits (key, count, reset_at) VALUES ('k4', 1, 0)").run() })(), StaleLeaseWrite)
  assert.throws(() => view.prepare("DELETE FROM rate_limits WHERE key = 'k1' RETURNING key").get(), StaleLeaseWrite)
  assert.equal(getPlan(view, 'tenant-1'), 'pro') // reads still work, and A's refused downgrade never landed
  assert.deepEqual((raw.prepare("SELECT key FROM rate_limits WHERE key LIKE 'k%' ORDER BY key").all() as { key: string }[]).map(r => r.key), ['k1', 'k2'])
  // B's fenced view writes
  setPlan(b.fenceSqlite(raw), 'tenant-1', 'free')
  assert.equal(getPlan(raw, 'tenant-1'), 'free')
  await db.close()
})

// PG: the fence check locks the lease row, so a takeover cannot slip in between A's check and A's write. A's
// transaction passes the check and holds; B's takeover waits for it; once A commits, B takes over and A's next
// transaction is refused.
test('[pg] a takeover waits for a fenced transaction in flight, and A is refused after it', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 4 })
  try {
    await runPgMigrations(db.pool)
    await db.run('CREATE TABLE fenced_effects (who TEXT NOT NULL, n BIGINT NOT NULL)')
    const { c, o } = clocked()
    const a = (await tryLease(db, 'job', o))!
    const ca = await db.pool.connect()
    try {
      await ca.query('BEGIN')
      const fenceA = await ca.query(toPgPlaceholders(FENCE_SQL), ['job', a.owner, a.generation, T0 + 900])
      assert.equal(fenceA.rowCount, 1) // A's check passes before expiry and now locks the row
      c.now = T0 + 1500 // the lease is past expiry from here on
      let bDone = false
      const bTakeover = tryLease(db, 'job', o).then(l => { bDone = true; return l })
      await new Promise(r => setTimeout(r, 300))
      assert.equal(bDone, false, 'takeover must wait for the fenced transaction in flight')
      await ca.query("INSERT INTO fenced_effects (who, n) VALUES ('A', 1)")
      await ca.query('COMMIT')
      const b = await bTakeover
      assert.ok(b && b.generation === 2)
    } finally { ca.release() }
    await assert.rejects(effect(db, a, 'A', 2), StaleLeaseWrite)
    assert.deepEqual((await db.all<{ who: string }>('SELECT who FROM fenced_effects')).map(r => r.who), ['A'])
  } finally { await db.close(); await s.drop() }
})
