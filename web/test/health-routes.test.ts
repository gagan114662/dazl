// The real /api/health, /api/health/ready and /api/health/live handlers (test/helpers/health-route-runtime.mts). Each
// store mode runs in its own process: getDb() picks the store once per process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pgSkip } from './helpers/pg-test.ts'

const TITLES: Record<string, string> = {
  'sqlite': 'SQLite store answers: 200 ready',
  'pg-down': 'Postgres unreachable: /api/health and readiness 503, liveness (/api/health/live) still 200',
  'pg': 'Postgres reachable with every shipped migration: store and schema ready (503 only while raw-SQLite modules remain)',
  'pg-behind': 'Postgres missing a shipped migration: 503 not ready (schema behind)',
  'env-missing': 'a required environment variable missing: 503 not ready by count only; /api/health (databases) and liveness 200',
  'stats-hang': 'the queue answers but its alert statistics hang: 200 ready, alerts null with reason timeout (#430)',
}

for (const mode of ['sqlite', 'pg-down', 'pg', 'pg-behind', 'env-missing', 'stats-hang']) {
  test(`health routes: ${TITLES[mode]}`, { skip: mode === 'pg' || mode === 'pg-behind' ? pgSkip : false }, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HEALTH_MODE: mode }
    delete env.NODE_TEST_CONTEXT
    // the net-fence preload scrubs DATABASE_URL, so the runtime sets it from this
    if (mode === 'pg-down') env.HEALTH_DATABASE_URL = 'postgres://dazl@127.0.0.1:1/none'
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
      '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/health-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /# pass 1\b/)
    assert.match(r.stdout, new RegExp(`HEALTH_ROUTES ${mode}\\b`))
  })
}
