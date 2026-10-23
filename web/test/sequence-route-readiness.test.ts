import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('real GET /api/outreach/sequences returns scheduler and tenant-scoped gates', () => {
  const web = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/sequence-route-loader.mjs', '--test', './test/helpers/sequence-route-readiness.mts'], { cwd: web, env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/)
})
