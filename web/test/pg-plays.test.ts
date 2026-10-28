// Plays (weekly watches and monitors, lib/watch.ts and lib/monitors.ts) on the Db layer, run on Postgres with two
// tenants: create, list and act on one's own; the other tenant's ids are refused and change nothing; the scheduled runs
// queue each tenant's own scan with the play's own query, record it, and fold the results into that play only. A run
// whose lease fence fails writes nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pgDb, type Tx } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { createWatch, listWatches, watchAction, runDueWatches, type Fence } from '../lib/watch.ts'
import { createMonitor, listMonitors, setMonitorEnabled, deleteMonitor, runDueMonitors, collectMonitorResults } from '../lib/monitors.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const ICP = JSON.stringify({ summary: 's' })

test('[pg] watches and monitors: tenant-scoped reads and actions, scheduled runs queue only the owner\'s scan', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    // both tenants have a key (watches never run trial-funded)
    for (const t of [A, B]) await db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [t])
    const now = 1_800_000_000
    const w = { A: (await createWatch(db, A, 'SECRET-a-WATCH', ICP, null, now)).watch!, B: (await createWatch(db, B, 'SECRET-b-WATCH', ICP, null, now)).watch! }
    const m = { A: await createMonitor(db, A, { query: 'SECRET-a-MONITOR' }, now), B: await createMonitor(db, B, { query: 'SECRET-b-MONITOR' }, now) }
    assert.ok('id' in m.A && 'id' in m.B)
    const mid = { A: (m.A as { id: string }).id, B: (m.B as { id: string }).id }

    // lists: own only
    assert.deepEqual((await listWatches(db, A)).map(x => x.query), ['SECRET-a-WATCH'])
    assert.deepEqual((await listMonitors(db, B)).map(x => x.query), ['SECRET-b-MONITOR'])
    // the other tenant's ids: refused, nothing changed
    for (const action of ['pause', 'resume', 'delete'] as const) assert.equal(await watchAction(db, A, w.B.id, action, now), false, action)
    assert.equal(await setMonitorEnabled(db, A, mid.B, false), false)
    assert.equal(await deleteMonitor(db, A, mid.B), false)
    assert.deepEqual(await db.get('SELECT active, next_run_at FROM watches WHERE id = ?', [w.B.id]), { active: 1, next_run_at: now + 7 * 86400 })
    assert.deepEqual(await db.get('SELECT enabled FROM monitors WHERE id = ?', [mid.B]), { enabled: 1 })

    // a run that lost its lease: the fence throws inside each transaction, so nothing is written
    const lost: Fence = function* () { throw new Error('lease lost') }
    const due = now + 8 * 86400
    await assert.rejects(runDueWatches(db, { now: due, fence: lost }), /lease lost/)
    await assert.rejects(runDueMonitors(db, { now: due, fence: lost }), /lease lost/)
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs'))!.n), 0)
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM monitor_runs'))!.n), 0)

    // scheduled runs: one job per play, for its owner, with the play's own query
    const ok = function* (t: Tx) { yield* t.get('SELECT 1') }
    assert.deepEqual(await runDueWatches(db, { now: due, fence: ok }), { ran: 2, paused: 0 })
    const wjobs = await db.all<{ user_id: string; query: string; watch_id: string }>('SELECT user_id, query, watch_id FROM scan_jobs WHERE watch_id IS NOT NULL ORDER BY user_id')
    assert.deepEqual(wjobs, [{ user_id: A, query: 'SECRET-a-WATCH', watch_id: w.A.id }, { user_id: B, query: 'SECRET-b-WATCH', watch_id: w.B.id }])
    // the same tick again: not due any more, nothing new
    assert.deepEqual(await runDueWatches(db, { now: due }), { ran: 0, paused: 0 })
    // monitors: each user has one active scan (the watch run); a monitor still runs beside one, never beside two
    const mjobs = await runDueMonitors(db, { now: due })
    assert.equal(mjobs.length, 2)
    const runs = await db.all<{ monitor_id: string; user_id: string; query: string }>('SELECT r.monitor_id, j.user_id, j.query FROM monitor_runs r JOIN scan_jobs j ON j.id = r.job_id ORDER BY j.user_id')
    assert.deepEqual(runs, [{ monitor_id: mid.A, user_id: A, query: 'SECRET-a-MONITOR' }, { monitor_id: mid.B, user_id: B, query: 'SECRET-b-MONITOR' }])
    assert.deepEqual(await runDueMonitors(db, { now: due }), [])

    // results fold into the owning monitor only, once
    for (const job of mjobs) {
      const owner = (await db.get<{ user_id: string }>('SELECT user_id FROM scan_jobs WHERE id = ?', [job]))!.user_id
      await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
      await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, dedup_key) VALUES (?, ?, 'n', 'c', 's', 'https://e.example', ?)", [job.slice(0, 12) + 'aaaaaaaaaaaa', job, `key-${owner.slice(0, 1)}`])
      await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [due, job])
    }
    assert.equal(await collectMonitorResults(db), 2)
    assert.equal(await collectMonitorResults(db), 0, 'each run is folded once')
    assert.deepEqual(await db.all('SELECT monitor_id, dedup_key FROM monitor_seen ORDER BY dedup_key'), [{ monitor_id: mid.A, dedup_key: 'key-a' }, { monitor_id: mid.B, dedup_key: 'key-b' }])
    assert.deepEqual((await listMonitors(db, A)).map(x => [x.last_new_count, x.run_count]), [[1, 1]])

    // own actions work
    assert.equal(await watchAction(db, A, w.A.id, 'pause', due), true)
    assert.equal(await deleteMonitor(db, B, mid.B), true)
    assert.equal((await listWatches(db, A))[0].active, false)
    assert.deepEqual(await listMonitors(db, B), [])
    assert.equal((await listMonitors(db, A)).length, 1, "B's delete left A's monitor")
  } finally { await db.close(); await s.drop() }
})
