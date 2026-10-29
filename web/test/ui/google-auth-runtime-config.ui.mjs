// Production-build check for Sign in with Google (staging caching fix). NOT part of `npm test`.
// Run:  cd web && env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_SIGNIN_CLIENT_ID -u GOOGLE_SIGNIN_CLIENT_SECRET \
//         -u PUBLIC_BASE_URL npm run build && node test/ui/google-auth-runtime-config.ui.mjs
// The build is made with NO Google configuration. The real server is then started twice from that same build, under
// test/helpers/net-fence.ts (no network): once with a staging identity-only sign-in client configured at runtime, once
// with nothing. With the client, /api/auth/google must redirect to Google with that client, the staging callback URL
// and an identity-only scope; without it, google_unavailable. Every response is no-store. Synthetic client id only.
// Exit 1 on a failed expectation; no build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-gauth-ui-'))
const SID = 'staging-signin-123.apps.googleusercontent.com'
const servers = []
async function serve(extra) {
  const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
  // the fence scrubs every *SECRET* variable it inherits, so the synthetic configuration is applied after it
  const runtimeEnv = path.join(tmp, `env${port}.mjs`); writeFileSync(runtimeEnv, `Object.assign(process.env, ${JSON.stringify(extra)})\n`)
  const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: path.join(tmp, `app${port}.db`), SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')} --import ${runtimeEnv}` }, stdio: 'ignore' })
  servers.push(srv)
  for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
  return (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers })
}
const noStore = r => assert.match(r.headers.get('cache-control') ?? '', /no-store/, `cache-control: ${r.headers.get('cache-control')}`)
try {
  // runtime configuration present: a dedicated staging sign-in client, no Gmail client
  const on = await serve({ DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai', GOOGLE_SIGNIN_CLIENT_ID: SID, GOOGLE_SIGNIN_CLIENT_SECRET: 'synthetic-secret' })
  for (let i = 0; i < 2; i++) { // twice: the second answer is not a cached copy of the first
    const r = await on('/api/auth/google', { 'x-forwarded-for': `10.1.0.${i}` })
    assert.equal(r.status, 307); noStore(r)
    const to = new URL(r.headers.get('location'))
    assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.equal(to.searchParams.get('client_id'), SID)
    assert.equal(to.searchParams.get('redirect_uri'), 'https://staging.dazl.ai/api/auth/callback/google')
    assert.equal(to.searchParams.get('scope'), 'openid email profile')
    const c = r.headers.getSetCookie().find(s => s.startsWith('dazl_oauth='))
    assert.ok(c && /HttpOnly/.test(c) && /Secure/.test(c) && /Path=\/api\/auth/.test(c) && /Domain=\.?staging\.dazl\.ai/i.test(c), c)
  }
  const cb = await on('/api/auth/callback/google?code=c&state=s')
  assert.equal(cb.headers.get('location'), 'https://staging.dazl.ai/sign-in?error=google_failed'); noStore(cb)
  // the Gmail client on staging disables sign-in, even with the dedicated client present
  const gmail = await serve({ DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai', GOOGLE_SIGNIN_CLIENT_ID: SID, GOOGLE_SIGNIN_CLIENT_SECRET: 'synthetic-secret', GOOGLE_CLIENT_SECRET: 'synthetic-gmail' })
  const g = await gmail('/api/auth/google'); assert.match(g.headers.get('location'), /error=google_unavailable$/); noStore(g)
  // absent configuration: unavailable, not cached
  const off = await serve({ DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai' })
  for (const p of ['/api/auth/google', '/api/auth/callback/google?code=c&state=s']) { const r = await off(p); assert.equal(r.status, 307); assert.match(r.headers.get('location'), /error=google_unavailable$/); noStore(r) }
  console.log('google auth runtime config check passed: a build without Google configuration signs in with the staging client configured at runtime, refuses with the Gmail client present, reports unavailable when absent, and never caches')
} catch (e) { console.error(e); process.exitCode = 1 } finally { for (const s of servers) s.kill(); rmSync(tmp, { recursive: true, force: true }) }
