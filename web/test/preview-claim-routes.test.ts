// Preview claim through the real route handlers (test/helpers/preview-claim-route-runtime.mts): the start route's
// cookies, the Google round trip, a foreign refusal, and the POST route's CSRF/auth/atomicity (#416).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

test('preview claim routes', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/preview-claim-route-loader.mjs', '--test', './test/helpers/preview-claim-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PREVIEW_START_OK[\s\S]*PREVIEW_GOOGLE_CLAIM_OK[\s\S]*PREVIEW_FOREIGN_OK[\s\S]*PREVIEW_CLAIM_ROUTE_OK[\s\S]*PREVIEW_ISSUE_ROUTE_OK/)
})

test('claiming is an intentional act: the claim page never POSTs on landing, only from its button', () => {
  const src = readFileSync(new URL('../app/preview/claim/page.tsx', import.meta.url), 'utf8')
  assert.ok(!/useEffect/.test(src), 'no effect fires a write on landing')
  assert.match(src, /onClick=\{submit\}/)
  assert.match(src, /Claim this preview/)
})
