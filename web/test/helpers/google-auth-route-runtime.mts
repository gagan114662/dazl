// Runs the REAL /api/auth/google and /api/auth/callback/google handlers against a temporary SQLite database, with
// Google's token and key endpoints answered by stubs (no network). Configuration is changed between requests on the
// same loaded modules, as runtime configuration added after a build would be.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const SID = 'staging-signin-123.apps.googleusercontent.com', SSEC = 'GOCSPX-staging-only-secret'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (claims: Record<string, unknown>) => { const h = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), c = b(claims); return `${h}.${c}.${createSign('RSA-SHA256').update(`${h}.${c}`).sign(privateKey).toString('base64url')}` }
// Google, stubbed: every call is recorded; the token endpoint answers with an ID token for the nonce under test
const calls: { url: string; body: string }[] = []
let nonce = '', idEmail = 'pat@example.test', idSub = 'g-1'
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u); calls.push({ url, body: String(init?.body ?? '') })
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }))
  if (url === 'https://oauth2.googleapis.com/token') {
    const aud = new URLSearchParams(String(init?.body)).get('client_id')
    return new Response(JSON.stringify({ id_token: sign({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: idSub, email: idEmail, email_verified: true, name: 'Pat' }) }))
  }
  throw new Error(`Unexpected network call ${url}`)
}) as typeof fetch

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-gauth-')), 'app.db')
const KEYS = ['DAZL_ENV', 'PUBLIC_BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_SIGNIN_CLIENT_ID', 'GOOGLE_SIGNIN_CLIENT_SECRET']
const setEnv = (e: Record<string, string>) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, e) }
setEnv({}) // the "build": nothing configured when the modules load
const start = await import('../../app/api/auth/google/route.ts')
const callback = await import('../../app/api/auth/callback/google/route.ts')
const { getAuthDb } = await import('../../lib/auth-db.ts')
let ip = 0
const req = (url: string, cookie?: string) => new NextRequest(url, { headers: { 'x-forwarded-for': `10.0.0.${++ip}`, ...(cookie ? { cookie } : {}) } })
const STAGING = { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai', GOOGLE_SIGNIN_CLIENT_ID: SID, GOOGLE_SIGNIN_CLIENT_SECRET: SSEC }
const noStore = (r: Response) => assert.match(r.headers.get('cache-control') ?? '', /no-store/, 'never cached')
const unavailable = (r: Response) => { assert.equal(r.status, 307); assert.match(r.headers.get('location')!, /\/sign-in\?error=google_unavailable$/); noStore(r) }

test('both routes are dynamic: configuration missing at load, then added, is used on the next request', async () => {
  // each handler opts out of prerendering before it reads configuration (the production build is checked by
  // test/ui/google-auth-runtime-config.ui.mjs)
  for (const f of ['app/api/auth/google/route.ts', 'app/api/auth/callback/google/route.ts']) assert.match(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'), /GET\(req: NextRequest\) \{\n(?:\s*\/\/.*\n)*\s*await connection\(\)\n\s*const cfg = signInConfig\(\)/)
  unavailable(await start.GET(req('https://staging.dazl.ai/api/auth/google')))
  unavailable(await callback.GET(req('https://staging.dazl.ai/api/auth/callback/google?code=c&state=s')))
  setEnv(STAGING)
  const r = await start.GET(req('https://staging.dazl.ai/api/auth/google'))
  assert.equal(r.status, 307); noStore(r)
  const to = new URL(r.headers.get('location')!)
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(to.searchParams.get('client_id'), SID)
  assert.equal(to.searchParams.get('redirect_uri'), 'https://staging.dazl.ai/api/auth/callback/google')
  assert.equal(to.searchParams.get('scope'), 'openid email profile', 'identity only: no Gmail scope')
  const set = r.headers.get('set-cookie')!
  for (const a of [/^dazl_oauth=[\w-]+\.[\w-]+\.[\w-]+;/, /Path=\/api\/auth/, /Domain=\.?staging\.dazl\.ai/i, /Secure/, /HttpOnly/, /SameSite=lax/i, /Max-Age=600/]) assert.match(set, a)
  // and removed again: unavailable again, nothing frozen either way
  setEnv({})
  unavailable(await start.GET(req('https://staging.dazl.ai/api/auth/google')))
  assert.equal(calls.length, 0)
})

test('staging: only the dedicated sign-in client at the staging address; any Gmail client credential disables sign-in', async () => {
  const cases: Record<string, string>[] = [
    { ...STAGING, GOOGLE_CLIENT_SECRET: 'GOCSPX-gmail' },                                     // the Gmail client present
    { ...STAGING, GOOGLE_CLIENT_ID: 'gmail.apps.googleusercontent.com' },
    { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.ai', GOOGLE_CLIENT_ID: SID, GOOGLE_CLIENT_SECRET: SSEC }, // no dedicated client
    { ...STAGING, PUBLIC_BASE_URL: 'https://dazl.ai' },                                       // production's address
    { ...STAGING, PUBLIC_BASE_URL: 'http://staging.dazl.ai' },                                // not https
    { ...STAGING, GOOGLE_SIGNIN_CLIENT_SECRET: '' },
  ]
  for (const e of cases) { setEnv(e); unavailable(await start.GET(req('https://staging.dazl.ai/api/auth/google'))); unavailable(await callback.GET(req('https://staging.dazl.ai/api/auth/callback/google?code=c&state=s'))) }
  // production keeps signing in with its existing client when no dedicated one is set
  setEnv({ PUBLIC_BASE_URL: 'https://dazl.ai', GOOGLE_CLIENT_ID: 'prod.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'p' })
  const r = await start.GET(req('https://dazl.ai/api/auth/google'))
  assert.equal(new URL(r.headers.get('location')!).searchParams.get('client_id'), 'prod.apps.googleusercontent.com')
  assert.equal(calls.length, 0)
})

test('the callback URL and redirects come from PUBLIC_BASE_URL, never from the request\'s Host', async () => {
  setEnv(STAGING)
  const r = await start.GET(req('https://evil.example/api/auth/google'))
  assert.equal(new URL(r.headers.get('location')!).searchParams.get('redirect_uri'), 'https://staging.dazl.ai/api/auth/callback/google')
  assert.doesNotMatch(r.headers.get('set-cookie')!, /evil/)
  const bad = await callback.GET(req('https://evil.example/api/auth/callback/google?code=c&state=s'))
  assert.equal(bad.headers.get('location'), 'https://staging.dazl.ai/sign-in?error=google_failed'); noStore(bad)
})

test('staging callback: a full sign-in sets the session, clears the one-time cookie, and calls only the stubbed Google endpoints', async () => {
  setEnv(STAGING)
  const s = await start.GET(req('https://staging.dazl.ai/api/auth/google'))
  const cookie = /dazl_oauth=([^;]+)/.exec(s.headers.get('set-cookie')!)![1]
  const [state, n] = cookie.split('.'); nonce = n
  // a wrong state is refused and the one-time cookie cleared with the attributes it was set with
  const wrong = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=c&state=${'x'.repeat(32)}`, `dazl_oauth=${cookie}`))
  assert.equal(wrong.headers.get('location'), 'https://staging.dazl.ai/sign-in?error=google_failed'); noStore(wrong)
  for (const a of [/dazl_oauth=;/, /Max-Age=0/, /Path=\/api\/auth/, /Domain=\.?staging\.dazl\.ai/i, /Secure/, /HttpOnly/]) assert.match(wrong.headers.get('set-cookie')!, a)
  const r = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=the-code&state=${state}`, `dazl_oauth=${cookie}`))
  assert.equal(r.headers.get('location'), 'https://staging.dazl.ai/app'); noStore(r)
  const [session, cleared] = r.headers.getSetCookie()
  for (const a of [/^dazl_session=[0-9a-f]{64};/, /Path=\/;/, /Domain=\.?staging\.dazl\.ai/i, /Secure/, /HttpOnly/, /SameSite=lax/i]) assert.match(session, a)
  assert.match(cleared, /^dazl_oauth=;.*Max-Age=0/)
  const token = new URLSearchParams(calls.find(c => c.url.endsWith('/token'))!.body)
  assert.equal(token.get('client_id'), SID); assert.equal(token.get('client_secret'), SSEC)
  assert.equal(token.get('redirect_uri'), 'https://staging.dazl.ai/api/auth/callback/google')
  assert.deepEqual([...new Set(calls.map(c => c.url))].sort(), ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs'])
  assert.equal((getAuthDb().prepare("SELECT count(*) n FROM users WHERE email = 'pat@example.test'").get() as { n: number }).n, 1)
  // Gmail stays stubbed in staging: signing in connected no Gmail account and nothing called Gmail
  assert.ok(!calls.some(c => c.url.includes('gmail')))
  console.log('GOOGLE_AUTH_ROUTES_OK')
})

test('re-authenticating with Google from Settings replaces this account\'s session and lands back on Settings', async () => {
  setEnv(STAGING)
  const s = await start.GET(req('https://staging.dazl.ai/api/auth/google?reauth=1'))
  const set = s.headers.getSetCookie()
  const cookie = /dazl_oauth=([^;]+)/.exec(set.join('\n'))![1]
  assert.ok(set.some(c => /^dazl_return=settings;.*Path=\/api\/auth/.test(c)))
  const [state, n] = cookie.split('.'); nonce = n
  const { createSession, getSessionUser } = await import('../../lib/auth-db.ts')
  const uid = (getAuthDb().prepare("SELECT id FROM users WHERE email = 'pat@example.test'").get() as { id: string }).id
  const old = await createSession(uid), other = await createSession('someone-else')
  const r = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=c2&state=${state}`, `dazl_oauth=${cookie}; dazl_return=settings; dazl_session=${old}`))
  assert.equal(r.headers.get('location'), 'https://staging.dazl.ai/app/settings')
  assert.ok(r.headers.getSetCookie().some(c => /^dazl_return=;.*Max-Age=0/.test(c)))
  assert.equal(await getSessionUser(old), null, 'the replaced session no longer works')
  // a cookie for another account is never touched by this sign-in
  const s2 = await start.GET(req('https://staging.dazl.ai/api/auth/google'))
  const c2 = /dazl_oauth=([^;]+)/.exec(s2.headers.get('set-cookie')!)![1]
  const [st2, n2] = c2.split('.'); nonce = n2
  const r2 = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=c3&state=${st2}`, `dazl_oauth=${c2}; dazl_session=${other}`))
  assert.equal(r2.headers.get('location'), 'https://staging.dazl.ai/app', 'no return cookie: the usual landing')
  assert.equal((getAuthDb().prepare('SELECT revoked_at FROM sessions WHERE user_id = ?').get('someone-else') as { revoked_at: number | null }).revoked_at, null)
  console.log('GOOGLE_REAUTH_OK')
})

test('linking Google from Settings: only the fresh, verified session of the account with that email; the session is kept', async () => {
  setEnv(STAGING)
  const { createPasswordUser, createSession } = await import('../../lib/auth-db.ts')
  await createPasswordUser({ id: 'L', email: 'link@example.test', name: 'L', business_name: 'L', password_hash: 'h', salt: 's' })
  getAuthDb().prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'L'").run()
  idEmail = 'link@example.test'; idSub = 'g-link'
  const flow = async (session?: string) => {
    const s = await start.GET(req('https://staging.dazl.ai/api/auth/google?link=1'))
    assert.ok(s.headers.getSetCookie().some(c => /^dazl_return=link;/.test(c)))
    const c = /dazl_oauth=([^;]+)/.exec(s.headers.getSetCookie().join('\n'))![1]
    const [state, n] = c.split('.'); nonce = n
    const r = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=l&state=${state}`, `dazl_oauth=${c}; dazl_return=link${session ? `; dazl_session=${session}` : ''}`))
    assert.ok(!r.headers.getSetCookie().some(x => /^dazl_session=[0-9a-f]/.test(x)), 'linking never makes a new session')
    return r.headers.get('location')
  }
  const linked = () => getAuthDb().prepare("SELECT user_id FROM oauth_identities WHERE subject = 'g-link'").get()
  assert.equal(await flow(), 'https://staging.dazl.ai/app/settings?google=signed_out#account')
  const stale = await createSession('L')
  getAuthDb().prepare('UPDATE sessions SET authed_at = ? WHERE user_id = ?').run(Math.floor(Date.now() / 1000) - 7200, 'L')
  assert.equal(await flow(stale), 'https://staging.dazl.ai/app/settings?google=reauth_required#account')
  assert.equal(linked(), undefined)
  const fresh = await createSession('L')
  assert.equal(await flow(fresh), 'https://staging.dazl.ai/app/settings?google=linked#account')
  assert.deepEqual(linked(), { user_id: 'L' })
  idEmail = 'pat@example.test'; idSub = 'g-1'
  console.log('GOOGLE_LINK_OK')
})
