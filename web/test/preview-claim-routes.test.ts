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
  assert.match(r.stdout, /PREVIEW_START_OK[\s\S]*PREVIEW_GOOGLE_CLAIM_OK[\s\S]*PREVIEW_FOREIGN_OK[\s\S]*PREVIEW_CLAIM_ROUTE_OK[\s\S]*PREVIEW_ISSUE_ROUTE_OK[\s\S]*PREVIEW_AUTH_FAILURE_INTENT_OK[\s\S]*PREVIEW_PASSWORD_RESUME_OK[\s\S]*PREVIEW_PASSWORD_INTENT_OK/)
})

test('claiming is an intentional act: the claim page never POSTs on landing, only from its button', () => {
  const src = readFileSync(new URL('../app/preview/claim/page.tsx', import.meta.url), 'utf8')
  const effects = src.match(/useEffect\([\s\S]*?\}, \[\]\)/g) ?? []
  assert.ok(effects.every(e => !/POST/.test(e)), 'no effect fires a write on landing (read-only fetches only)')
  assert.match(src, /onClick=\{submit\}/)
  assert.match(src, /Claim this preview/)
})

test('the public preview page sends Create account / Sign in through the validating start, which keeps a server intent (#416)', () => {
  const src = readFileSync(new URL('../app/preview/[token]/cta.tsx', import.meta.url), 'utf8')
  assert.match(src, /\/continue\?to=sign-up/)
  assert.match(src, /\/continue\?to=sign-in/)
  assert.doesNotMatch(src, /go\('\/sign-(up|in)'\)/, 'never straight to the auth pages: a confirmation link opened in a new tab would lose the claim')
})

test('the claim page has a way out that clears the intent (#416 review)', () => {
  const src = readFileSync(new URL('../app/preview/claim/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /Not now, go to my workspace/)
  assert.match(src, /method: 'DELETE'/)
  assert.match(src, /router\.push\('\/app'\)/) // the Next router, not a raw location assignment (static-quality)
})
