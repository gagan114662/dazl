// Per-play offer through the real routes (test/helpers/play-offer-route-runtime.mts): POST /api/scan refuses an
// unresolved offer conflict, stores the reviewed offer; GET/POST /api/campaigns/[id] read and set it, owner only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('per-play offer through POST /api/scan and /api/campaigns/[id] (real handlers, two tenants, stubbed)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/play-offer-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/); assert.match(r.stdout, /# fail 0/)
})
