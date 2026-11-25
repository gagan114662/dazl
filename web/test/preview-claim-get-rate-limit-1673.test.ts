// #1673: the preview confirmation GET carries the same per-IP rate limit as the sibling preview routes
// (test/helpers/preview-claim-get-rate-limit-1673-runtime.mts runs the real handler over a SQLite fixture).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('preview claim GET rate limit (#1673)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/preview-claim-route-loader.mjs', '--test', './test/helpers/preview-claim-get-rate-limit-1673-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PREVIEW_CLAIM_GET_RATE_LIMIT_OK[\s\S]*PREVIEW_CLAIM_GET_TOKEN_BUDGET_OK/)
})
