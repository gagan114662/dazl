// A newer failed or lease-lost tick is a problem even while an earlier success is still recent (#447 review). Freshness
// (the last completed run's age) is reported separately; the unresolved latest failure is in health problems, the
// health response status and the shipped monitor (scripts/ops/scheduler-check.mts), until a newer run succeeds.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { finishRun, schedulerHealth, schedulerHealthResponse, startRun, type SchedulerHealth } from '../lib/ops/scheduler-runs.ts'
import type { DbLike } from '../lib/db/client.ts'

const N = 1_900_000_000
const lease = { owner: 'o', generation: 3 }
const run = async (db: DbLike, start: number, end: number, status: 'ok' | 'partial' | 'failed' | 'lease_lost', err?: unknown) => finishRun(db, await startRun(db, lease, N + start), status, err, N + end)
const failing = (h: SchedulerHealth) => h.problems.filter(p => /latest scheduler run/.test(p))

for (const status of ['failed', 'lease_lost'] as const) {
  bothEngines(`${status} after an earlier recent ok is unresolved until a newer run succeeds`, async ({ db }) => {
    await run(db, -900, -850, 'ok')
    await run(db, -60, -30, status, status === 'failed' ? new Error('tick_store_failure') : undefined)
    const h = await schedulerHealth(db, N)
    assert.equal(h.ok, false, JSON.stringify(h))
    assert.equal(h.operational.state, 'fresh', 'freshness is still the earlier completion, reported separately')
    assert.equal(h.operational.unresolved_failure?.status, status)
    assert.equal(h.operational.unresolved_failure?.finished_at, N - 30)
    assert.deepEqual(failing(h), [`latest scheduler run ${status}: no successful run since`])
    if (status === 'failed') assert.equal(h.operational.last_error_class, 'Error')
    assert.equal((await schedulerHealthResponse(db, N)).status, 503)
    // a run in progress after the failure does not resolve it
    const live = await startRun(db, lease, N + 10)
    assert.equal(failing(await schedulerHealth(db, N + 20)).length, 1)
    // a genuine newer success clears it
    await finishRun(db, live, 'ok', undefined, N + 40)
    const ok = await schedulerHealth(db, N + 60)
    assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.operational.unresolved_failure, null); assert.deepEqual(ok.problems, [])
    assert.equal((await schedulerHealthResponse(db, N + 60)).status, 200)
  })
}

bothEngines('a partial run (some tenant failed) is a completion, not an unresolved scheduler failure', async ({ db }) => {
  await run(db, -900, -850, 'failed', new Error('boom'))
  await run(db, -60, -30, 'partial')
  const h = await schedulerHealth(db, N)
  assert.equal(h.operational.unresolved_failure, null); assert.deepEqual(failing(h), [])
})

// The shipped monitor against the real health response: the failed-after-ok store alerts, the recovered store announces
// recovery.
test('scheduler-check alerts on a failed tick after an ok one, and announces recovery after a newer success', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  await run(raw, -900, -850, 'ok')
  await run(raw, -60, -30, 'failed', new Error('tick_store_failure'))
  let at = N
  const server = http.createServer(async (_q, s) => { const r = await schedulerHealthResponse(raw, at); s.statusCode = r.status; s.end(await r.text()) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health/scheduler`
  const T = mkdtempSync(path.join(tmpdir(), 'sched-fail-')), alerts = path.join(T, 'alerts.log'), cmd = path.join(T, 'alert.sh')
  writeFileSync(cmd, `#!/bin/sh\necho "$1" >> ${alerts}\n`); chmodSync(cmd, 0o755)
  const sent = () => existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  const check = () => new Promise<number>(r => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops/scheduler-check.mts', '--url', url, '--state-dir', path.join(T, 'state')],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, SCHEDULER_ALERT_CMD: cmd, OPS_ALERT_WEBHOOK_URL: '' }, stdio: 'ignore' }).on('exit', c => r(c ?? -1)))
  try {
    assert.equal(await check(), 1)
    assert.deepEqual(sent()[0].problems, ['latest scheduler run failed: no successful run since'])
    assert.equal(sent()[0].last_failure_status, 'failed')
    assert.ok(!JSON.stringify(sent()).includes('tick_store_failure'), 'the alert carries no error text')
    await run(raw, 10, 40, 'ok'); at = N + 60
    assert.equal(await check(), 0); assert.equal(sent().at(-1).type, 'scheduler_recovered')
  } finally { server.close(); rmSync(T, { recursive: true, force: true }) }
})
