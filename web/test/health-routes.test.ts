// The real /api/health, /api/health/ready and /api/health/live handlers (test/helpers/health-route-runtime.mts). Each
// store mode runs in its own process: getDb() picks the store once per process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

for (const mode of ['sqlite', 'pg-down']) {
  test(`health routes: ${mode === 'sqlite' ? 'SQLite store answers: 200 ready' : 'Postgres unreachable: 503 not ready, liveness still 200'}`, () => {
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
