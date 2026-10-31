import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The real tick route and captured-trace retention (PR #463 review): zero deletions unless capture is on or a retention
// was set explicitly (test/helpers/trace-purge-tick-runtime.mts).
test('tick route: trace purge deletes nothing with capture unset/off/invalid; purges past the retention when on or explicitly set', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/trace-purge-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  // the tap reporter (CI, piped) prints "# pass 2"; the spec reporter (a newer node on a terminal) prints "ℹ pass 2"
  assert.match(r.stdout, /^(?:# |ℹ )pass 2$/m)
  assert.match(r.stdout, /^(?:# |ℹ )fail 0$/m)
})
