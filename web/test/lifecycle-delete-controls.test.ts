// #568 lifecycle panel owner-only controls (test/helpers/lifecycle-delete-controls-runtime.mts). The runtime
// compiles the real .tsx component through a loader, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

test('lifecycle panel: delete/resume controls follow the server can_delete flag (real component)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tsx-loader.mjs', '--test', './test/helpers/lifecycle-delete-controls-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /LIFECYCLE DELETE CONTROLS ok/)
})

test('lifecycle panel export line names what is left out, redacted and generalized - never a complete-export claim', () => {
  const src = readFileSync(fileURLToPath(new URL('../app/app/settings/lifecycle-panel.tsx', import.meta.url)), 'utf8')
  assert.match(src, /sign-in records are left out, stored credentials are redacted, and internal conversion markers are generalized/, 'exportTenant excludes sessions/oauth_states, redacts REDACTED_COLUMN and generalizes conversion markers; the panel says so')
  assert.ok(!src.includes('Everything this workspace holds'), 'no complete-export claim')
})
