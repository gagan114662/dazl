// Sign in with Google, through the real route handlers (test/helpers/google-auth-route-runtime.mts): configuration is
// read per request (a build without it does not freeze "unavailable"), every response is no-store, staging signs in
// only with a dedicated identity-only client at its own address, and the callback never trusts the request's Host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { signInConfig } from '../lib/auth-google.ts'

test('signInConfig: dedicated client first; staging needs it, its own https address and no Gmail credentials', () => {
  const S = { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai/', GOOGLE_SIGNIN_CLIENT_ID: 's.apps.googleusercontent.com', GOOGLE_SIGNIN_CLIENT_SECRET: 'ss' }
  assert.deepEqual(signInConfig(S), { base: 'https://staging.dazl.ai', clientId: 's.apps.googleusercontent.com', clientSecret: 'ss', redirectUri: 'https://staging.dazl.ai/api/auth/callback/google' })
  assert.equal(signInConfig({}), null)
  assert.equal(signInConfig({ ...S, GOOGLE_CLIENT_SECRET: 'g' }), null)
  assert.equal(signInConfig({ ...S, PUBLIC_BASE_URL: 'https://dazl.ai' }), null)
  assert.equal(signInConfig({ ...S, PUBLIC_BASE_URL: 'https://staging.dazl.ai.evil.example/x' }), null)
  const P = { PUBLIC_BASE_URL: 'https://dazl.ai', GOOGLE_CLIENT_ID: 'p', GOOGLE_CLIENT_SECRET: 'pp' }
  assert.equal(signInConfig(P)?.clientId, 'p', 'production: the existing client, as before')
  assert.equal(signInConfig({ ...P, GOOGLE_SIGNIN_CLIENT_ID: 'd', GOOGLE_SIGNIN_CLIENT_SECRET: 'dd' })?.clientId, 'd')
  assert.equal(signInConfig({ ...P, GOOGLE_SIGNIN_CLIENT_ID: 'd' }), null, 'half a dedicated pair is not silently replaced by the Gmail client')
})

test('the real routes: dynamic, no-store, staging client and callback checks', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/google-auth-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 5\b/)
  assert.match(r.stdout, /GOOGLE_AUTH_ROUTES_OK/)
})
