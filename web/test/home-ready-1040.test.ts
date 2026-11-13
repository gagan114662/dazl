// #1040 acceptance 1: Home's Ready tile = the Leads page's ready leads. Runs test/helpers/home-ready-runtime.mts in a child
// process (the real /api/leads and /api/home/ready handlers with their own session and store).
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('#1040 Ready tile: equals the Leads page, bounded, 401/200 (child process)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/home-ready-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 4/); assert.match(r.stdout, /# fail 0/)
})
