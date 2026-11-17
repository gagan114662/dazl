// #1176: runs test/helpers/usable-check-route-runtime.mts in a child process (the real operator route over a real scan's lead).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('#1176 GET /api/internal/usable-check: readers 3 and 4 count a proven-day lead; operator only; read-only (real route; child process)', () => {
  const env = { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' } as NodeJS.ProcessEnv; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/usable-check-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /USABLE CHECK ROUTE ok/); assert.match(r.stdout, /# fail 0/)
})
