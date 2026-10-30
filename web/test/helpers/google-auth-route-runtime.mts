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
let nonce = ''
globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u); calls.push({ url, body: String(init?.body ?? '') })
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }))
  if (url === 'https://oauth2.googleapis.com/token') {
    const aud = new URLSearchParams(String(init?.body)).get('client_id')
    return new Response(JSON.stringify({ id_token: sign({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: 'g-1', email: 'pat@example.test', email_verified: true, name: 'Pat' }) }))
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

test('#416 where the user was going survives the Google round trip; a failure keeps it; an unsafe destination is dropped', async () => {
  setEnv(STAGING)
  const begin = async (next: string) => {
    const s = await start.GET(req(`https://staging.dazl.ai/api/auth/google?next=${encodeURIComponent(next)}`))
    const all = s.headers.getSetCookie().join('\n')
    const oauth = /dazl_oauth=([^;]+)/.exec(all)![1]
    nonce = oauth.split('.')[1]
    return { all, oauth, state: oauth.split('.')[0], next: /dazl_oauth_next=([^;]*)/.exec(all)?.[1] ?? '' }
  }
  const a = await begin('/app/plays?id=7')
  assert.equal(decodeURIComponent(a.next), '/app/plays?id=7')
  for (const attr of [/dazl_oauth_next=[^;]+;.*Path=\/api\/auth/, /dazl_oauth_next=[^;]+;.*HttpOnly/, /dazl_oauth_next=[^;]+;.*Max-Age=600/]) assert.match(a.all, attr)
  const jar = `dazl_oauth=${a.oauth}; dazl_oauth_next=${a.next}`
  const fail = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=c&state=${'x'.repeat(32)}`, jar))
  assert.equal(fail.headers.get('location'), 'https://staging.dazl.ai/sign-in?error=google_failed&next=%2Fapp%2Fplays%3Fid%3D7', 'failure: back to sign-in, destination kept')
  assert.match(fail.headers.getSetCookie().join('\n'), /dazl_oauth_next=;.*Max-Age=0/)
  const ok = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=the-code&state=${a.state}`, jar))
  assert.equal(ok.headers.get('location'), 'https://staging.dazl.ai/app/plays?id=7', 'signed in: lands where it was going')
  assert.match(ok.headers.getSetCookie().join('\n'), /dazl_oauth_next=;.*Max-Age=0/)
  // Open-redirect attempts never become a destination, at the start or as a forged cookie at the callback.
  for (const bad of ['//evil.example/app', 'https://evil.example/app', '/\\evil.example', '/apple', '/app/../admin', '/%2e%2e/admin']) {
    const b2 = await begin(bad)
    assert.equal(b2.next, '', bad)
  }
  const c = await begin('/app')
  const forged = await callback.GET(req(`https://staging.dazl.ai/api/auth/callback/google?code=the-code&state=${c.state}`, `dazl_oauth=${c.oauth}; dazl_oauth_next=${encodeURIComponent('https://evil.example/x')}`))
  assert.equal(forged.headers.get('location'), 'https://staging.dazl.ai/app')
})
