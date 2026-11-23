// The beta rules at the routes (test/helpers/beta-rules-routes-runtime.mts): the server refuses to enable autopilot and to
// start a checkout while their switches are off, whatever a page shows. The runtime loads route modules through a resolver
// hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('beta rules at the routes: autopilot cannot be enabled, a checkout cannot be started', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/beta-rules-routes-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0\b|ℹ fail 0\b/)
  assert.match(r.stdout, /BETA_ROUTES autopilot\b/)
  assert.match(r.stdout, /BETA_ROUTES billing\b/)
  assert.match(r.stdout, /BETA_ROUTES sequences\b/) // #1620
})
