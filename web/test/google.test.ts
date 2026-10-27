import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, createSign } from 'node:crypto'
import { exchangeCode, parseCookie, resolveUser, startAuth, verifyIdToken } from '../lib/auth-google.ts'
import { bothEngines } from './helpers/engines.ts'

const CID = 'cid.apps.googleusercontent.com'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const jwksFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch
const NOW = 1_800_000_000
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function token(claims: Record<string, unknown>, key = privateKey, kid = 'k1', alg = 'RS256') {
  const head = b({ alg, kid, typ: 'JWT' }), body = b(claims)
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')
  return `${head}.${body}.${sig}`
}
const good = { iss: 'https://accounts.google.com', aud: CID, exp: NOW + 600, nonce: 'N'.repeat(32), sub: '1234', email: 'Pat@Example.com', email_verified: true, name: 'Pat' }
const v = (t: string, nonce = good.nonce) => verifyIdToken(t, { clientId: CID, nonce, fetchImpl: jwksFetch, now: NOW })

test('startAuth builds a PKCE + state + nonce request and a parseable cookie', () => {
  const s = startAuth(CID, 'https://dazl.ai/api/auth/callback/google')
  const u = new URL(s.url)
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(u.searchParams.get('scope'), 'openid email profile')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://dazl.ai/api/auth/callback/google')
  const c = parseCookie(s.cookie)!
  assert.equal(u.searchParams.get('state'), c.state)
  assert.equal(u.searchParams.get('nonce'), c.nonce)
  assert.equal(u.searchParams.get('code_challenge'), createHash('sha256').update(c.verifier).digest('base64url'))
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(parseCookie('junk'), null)
})

test('a valid token gives the identity with the email lowercased', async () => {
  assert.deepEqual(await v(token(good)), { sub: '1234', email: 'pat@example.com', name: 'Pat' })
})

test('rejects bad signature, wrong key id, alg none, wrong audience, issuer, expiry, nonce', async () => {
  assert.equal(await v(token(good, other.privateKey)), 'bad_signature')
  assert.equal(await v(token(good, privateKey, 'zzz')), 'bad_signature')
  assert.equal(await v(token(good, privateKey, 'k1', 'none')), 'bad_signature')
  assert.equal(await v(token({ ...good, aud: 'other' })), 'bad_claims')
  assert.equal(await v(token({ ...good, iss: 'https://evil.example' })), 'bad_claims')
  assert.equal(await v(token({ ...good, exp: NOW - 1 })), 'bad_claims')
  assert.equal(await v(token(good), 'X'.repeat(32)), 'bad_claims')
  assert.equal(await v('a.b'), 'bad_token')
})

test('email_verified must be exactly true', async () => {
  assert.equal(await v(token({ ...good, email_verified: false })), 'email_not_verified')
  assert.equal(await v(token({ ...good, email_verified: 'true' })), 'email_not_verified')
  const { email_verified: _x, ...no } = good
  assert.equal(await v(token(no)), 'email_not_verified')
})

test('exchangeCode sends the verifier and secret and returns only the id_token', async () => {
  let body = ''
  const f = (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response(JSON.stringify({ id_token: 'T', access_token: 'A' })) }) as unknown as typeof fetch
  assert.equal(await exchangeCode('C', { clientId: CID, clientSecret: 'S', redirectUri: 'R', verifier: 'V', fetchImpl: f }), 'T')
  assert.ok(body.includes('code_verifier=V') && body.includes('client_secret=S') && body.includes('grant_type=authorization_code'))
  const bad = (async () => new Response('no', { status: 400 })) as typeof fetch
  assert.equal(await exchangeCode('C', { clientId: CID, clientSecret: 'S', redirectUri: 'R', verifier: 'V', fetchImpl: bad }), null)
})

bothEngines('new Google identity creates an account; same identity signs in again; email changes do not matter', async ({ db }) => {
  const a = await resolveUser(db, { sub: '1', email: 'a@x.com', name: 'A' })
  assert.ok('created' in a && a.created)
  const again = await resolveUser(db, { sub: '1', email: 'renamed@x.com', name: 'A' })
  assert.deepEqual(again, { user_id: (a as { user_id: string }).user_id, created: false })
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM users'))!.n), 1)
})

bothEngines('an existing email account is never linked to a Google identity', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES ('u1','a@x.com','h','s')")
  assert.deepEqual(await resolveUser(db, { sub: '9', email: 'a@x.com', name: '' }), { error: 'email_exists' })
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM oauth_identities'))!.n), 0)
})

bothEngines('Google accounts get a random unusable password hash', async ({ db }) => {
  await resolveUser(db, { sub: '1', email: 'a@x.com', name: '' })
  await resolveUser(db, { sub: '2', email: 'b@x.com', name: '' })
  const h = await db.all<{ password_hash: string }>('SELECT password_hash FROM users')
  assert.notEqual(h[0].password_hash, h[1].password_hash)
  assert.ok(h[0].password_hash.length >= 64)
})

bothEngines('the same new Google identity resolving concurrently creates one account', async ({ db }) => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => resolveUser(db, { sub: '7', email: 'c@x.com', name: '' })))
  const ids = new Set(rs.map(r => (r as { user_id: string }).user_id))
  assert.equal(ids.size, 1)
  assert.equal(rs.filter(r => 'created' in r && r.created).length, 1)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM users'))!.n), 1)
}, { pgMax: 5 })
