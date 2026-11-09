// #905: the active-watch cap and the active duplicate-query rule are one atomic check, shared by create and resume, on
// both stores; monitor creation's stored-monitor limit is atomic too. Concurrency uses two Db handles on Postgres (two
// pools on one schema), so the race crosses connections like two app instances. No scheduler or scan runs here.
import assert from 'node:assert/strict'
import { pgDb, type Db } from '../lib/db/client.ts'
import { createWatch, watchAction, MAX_WATCHES } from '../lib/watch.ts'
import { createMonitor, MONITOR_LIMITS } from '../lib/monitors.ts'
import { bothEngines, type EngineCtx } from './helpers/engines.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const ICP = JSON.stringify({ summary: 's' })
const NOW = 1_800_000_000, WEEK = 7 * 86400

async function withSecond(c: EngineCtx, body: (d2: Db) => Promise<void>) {
  if (c.kind !== 'pg') return body(c.db)
  const d2 = pgDb({ connectionString: c.url!, searchPath: c.schema })
  try { await body(d2) } finally { await d2.close() }
}
const activeCount = async (db: Db, u: string) => Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM watches WHERE user_id = ? AND active = 1', [u]))!.n)

bothEngines('pause, create a 4th, then resume the paused one: refused, stays paused with its schedule', async ({ db }) => {
  const ws = []
  for (let i = 0; i < MAX_WATCHES; i++) ws.push((await createWatch(db, A, `q${i}`, ICP, null, NOW)).watch!)
  assert.equal(await watchAction(db, A, ws[0].id, 'pause', NOW), true)
  await db.run("UPDATE watches SET paused_reason = 'no_api_key' WHERE id = ?", [ws[0].id])
  assert.ok((await createWatch(db, A, 'q-new', ICP, null, NOW)).watch)
  const r = await watchAction(db, A, ws[0].id, 'resume', NOW + 50)
  assert.deepEqual(r, { error: `You already have ${MAX_WATCHES} active weekly watches. Pause or delete one first.`, code: 'watch_limit' })
  assert.equal(await activeCount(db, A), MAX_WATCHES)
  assert.deepEqual(await db.get('SELECT active, paused_reason, next_run_at FROM watches WHERE id = ?', [ws[0].id]), { active: 0, paused_reason: 'no_api_key', next_run_at: NOW + WEEK })
  const c = await createWatch(db, A, 'one more', ICP, null, NOW)
  assert.equal(c.code, 'watch_limit')
})

bothEngines('resuming a paused watch whose query is already active again is refused as a duplicate', async ({ db }) => {
  const w = (await createWatch(db, A, 'same', ICP, null, NOW)).watch!
  await watchAction(db, A, w.id, 'pause', NOW)
  assert.ok((await createWatch(db, A, 'same', ICP, null, NOW)).watch)
  assert.equal(((await watchAction(db, A, w.id, 'resume', NOW)) as { code: string }).code, 'watch_duplicate')
  assert.equal((await createWatch(db, A, 'same', ICP, null, NOW)).code, 'watch_duplicate')
})

bothEngines('already-active resume is idempotent and keeps next_run_at', async ({ db }) => {
  const w = (await createWatch(db, A, 'q', ICP, null, NOW)).watch!
  assert.equal(await watchAction(db, A, w.id, 'resume', NOW + 999), true)
  assert.deepEqual(await db.get('SELECT active, next_run_at FROM watches WHERE id = ?', [w.id]), { active: 1, next_run_at: NOW + WEEK })
  assert.equal(await watchAction(db, B, w.id, 'resume', NOW), false, 'another tenant: not found')
})

bothEngines('concurrent creates never exceed the cap or duplicate a query', async c => {
  await withSecond(c, async d2 => {
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => createWatch(i % 2 ? d2 : c.db, A, `q${i}`, ICP, null, NOW)))
    assert.equal(rs.filter(r => r.watch).length, MAX_WATCHES)
    assert.ok(rs.filter(r => !r.watch).every(r => r.code === 'watch_limit'))
    const dup = await Promise.all([createWatch(c.db, B, 'dup', ICP, null, NOW), createWatch(d2, B, 'dup', ICP, null, NOW)])
    assert.equal(dup.filter(r => r.watch).length, 1)
    assert.equal(await activeCount(c.db, A), MAX_WATCHES)
    assert.equal(await activeCount(c.db, B), 1, 'cross-tenant: B unaffected by A at the cap')
  })
})

bothEngines('concurrent resumes never exceed the cap', async c => {
  await withSecond(c, async d2 => {
    // five paused watches (made a few at a time under the cap), then one live: only MAX_WATCHES - 1 resumes fit
    const made: { id: string }[] = []
    for (let i = 0; i < MAX_WATCHES + 2; i++) { const x = (await createWatch(c.db, A, `q${i}`, ICP, null, NOW)).watch!; await watchAction(c.db, A, x.id, 'pause', NOW); made.push(x) }
    await createWatch(c.db, A, 'live', ICP, null, NOW)
    const rs = await Promise.all(made.map((w, i) => watchAction(i % 2 ? d2 : c.db, A, w.id, 'resume', NOW)))
    assert.equal(rs.filter(r => r === true).length, MAX_WATCHES - 1)
    assert.equal(await activeCount(c.db, A), MAX_WATCHES)
  })
})

bothEngines('concurrent monitor creates respect the stored-monitor limit', async c => {
  await withSecond(c, async d2 => {
    const max = MONITOR_LIMITS.free.maxMonitors
    const rs = await Promise.all(Array.from({ length: max + 2 }, (_, i) => createMonitor(i % 2 ? d2 : c.db, A, { query: `monitor ${i}` }, NOW)))
    assert.equal(rs.filter(r => 'id' in r).length, max)
    assert.equal(Number((await c.db.get<{ n: number }>('SELECT count(*) AS n FROM monitors WHERE user_id = ?', [A]))!.n), max)
    assert.ok('id' in await createMonitor(c.db, B, { query: 'b monitor' }, NOW), 'other tenant unaffected')
  })
})
