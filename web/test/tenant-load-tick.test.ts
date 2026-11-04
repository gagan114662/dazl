// #355 acceptance: multi-tenant load through the REAL tick route and the REAL scan runner (in-memory SQLite, stubbed
// Gmail and model provider, net-fenced). The scenario and its control are in test/helpers/tenant-load-tick-runtime.mts;
// it runs in its own process because the route needs the fixture-store loader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('[sqlite] tick route under tenant load: fair reply checks and scans; the rolled-back claimer starves them (control)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-load-tick-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/tenant-load-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
  assert.match(r.stdout, /# fail 0/)
})
