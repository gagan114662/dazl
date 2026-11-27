import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pgDb, type Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { recordProgress, startRun } from '../lib/ops/scheduler-runs.ts'
import { freshSchema, PG_URL, pgSkip } from './helpers/pg-test.ts'

async function assertOutcomes(db: Db, runId: string, tenants: string[]) {
  const rows = await db.all(
    'SELECT tenant_id, last_outcome FROM scheduler_progress WHERE last_run_id = ? ORDER BY tenant_id',
    [runId],
  )
  assert.deepEqual(rows, [
    { tenant_id: tenants[0], last_outcome: 'failure' },
    { tenant_id: tenants[1], last_outcome: 'hold' },
  ])
  assert.deepEqual(await db.get(
    'SELECT tenants_attempted, tenants_failed FROM scheduler_runs WHERE id = ?', [runId],
  ), { tenants_attempted: 2, tenants_failed: 1 })
}

test('PostgreSQL scheduler totals retain both tenant outcomes with overlapping updates', { skip: pgSkip }, async () => {
  const { schema, drop } = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: schema })
  const url = new URL(PG_URL!)
  url.searchParams.set('application_name', schema)
  const firstDb = pgDb({ connectionString: url.href, searchPath: schema })
  const failure = { outcome: 'failure', error: new Error('reply_sync_failed') } as const
  const hold = { outcome: 'hold', reason: 'paused' } as const
  const lease = { owner: 'scheduler-totals-test', generation: 1 }
  const gate = await db.pool.connect()
  const pending: Promise<void>[] = []
  try {
    await runPgMigrations(db.pool)
    const sequential = await startRun(db, lease)
    await recordProgress(db, sequential, 'control-a', 'reply_sync', failure)
    await recordProgress(db, sequential, 'control-b', 'reply_sync', hold)
    await assertOutcomes(db, sequential, ['control-a', 'control-b'])

    const overlapping = await startRun(db, lease)
    // Pause the first totals UPDATE after PostgreSQL takes its statement snapshot.
    // The other connection can then record a tenant and attempt its own update.
    await db.pool.query(`
      CREATE FUNCTION pause_scheduler_totals() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('application_name') = '${schema}' THEN
          PERFORM pg_advisory_xact_lock(TG_RELID::bigint);
        END IF;
        RETURN NULL;
      END
      $$;
      CREATE TRIGGER pause_scheduler_totals BEFORE UPDATE ON scheduler_runs
        FOR EACH STATEMENT EXECUTE FUNCTION pause_scheduler_totals();
    `)
    await gate.query("SELECT pg_advisory_lock('scheduler_runs'::regclass::oid::bigint)")
    const first = recordProgress(firstDb, overlapping, 'overlap-a', 'reply_sync', failure)
    pending.push(first)
    const waitFor = async (ready: () => Promise<boolean>, message: string) => {
      const deadline = Date.now() + 5000
      while (!(await ready())) {
        assert.ok(Date.now() < deadline, message)
        await delay(10)
      }
    }
    await waitFor(async () => Boolean((await db.pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [schema],
    )).rowCount), 'first totals update reached the advisory lock')

    let secondFinished = false
    const second = recordProgress(db, overlapping, 'overlap-b', 'reply_sync', hold)
      .then(() => { secondFinished = true })
    pending.push(second)
    await waitFor(async () => secondFinished || Boolean((await db.pool.query(
      `SELECT 1 FROM pg_stat_activity AS waiting
       JOIN pg_stat_activity AS first ON first.pid = ANY(pg_blocking_pids(waiting.pid))
       WHERE first.application_name = $1`, [schema],
    )).rowCount), 'second totals update completed or waited for the first transaction')
    await gate.query('SELECT pg_advisory_unlock_all()')
    await Promise.all(pending)
    await assertOutcomes(db, overlapping, ['overlap-a', 'overlap-b'])
  } finally {
    await gate.query('SELECT pg_advisory_unlock_all()')
    gate.release()
    await Promise.allSettled(pending)
    await firstDb.close()
    await db.close()
    await drop()
  }
})
