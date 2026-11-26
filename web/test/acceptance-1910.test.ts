// #1910 acceptance: prod job 0e6a919e's Austin rows as a fixture, run through the readiness and hold pipeline.
// Runs test/helpers/acceptance-1910-runtime.mts in a child process (the real homeReady on a seeded store).
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('#1910 acceptance: Austin 0e6a919e - 0 Ready today, Ready >= 1 marked todo until S1/S2/S3 land (child process)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/acceptance-1910-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/); assert.match(r.stdout, /# todo 1/)
})
