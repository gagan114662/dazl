// #1062 live check (prod 23c6533, PARTIAL): Home's ready lines / checked list / latest leads and the Past scans link text read the
// company-first gate. Runs test/helpers/company-first-home-1062-runtime.mts in a child process (real route handlers, stubbed session).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Home and Past scans: company-first held candidates are never "need your review" or leads (real handlers, no network)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/company-first-home-1062-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/); assert.match(r.stdout, /# fail 0/)
})
