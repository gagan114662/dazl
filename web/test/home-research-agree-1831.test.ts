// #1831: Home/header ready counts must use the Leads page's Research rule. Runs the runtime in a child process (the
// real homeReady + leadHoldReason with their own store), like the #1040 harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('#1831 Home ready count agrees with the Leads page for a Research lead (child process)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/home-research-agree-1831-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 3/); assert.match(r.stdout, /# fail 0/)
})
