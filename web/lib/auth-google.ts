import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db } from './db/client.ts'

// Sign in with Google: authorization code + PKCE + state + nonce, identity only
// (openid email profile). The ID token is checked here before anyone is signed in.

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const b64u = (b: Buffer) => b.toString('base64url')

export interface OauthStart { url: string; cookie: string }

// cookie is "state.nonce.verifier", kept in an HttpOnly cookie for 10 minutes.
// The OAuth start and callback can run on different hosts (a user on www.dazl.ai starts
// the flow; PUBLIC_BASE_URL points the callback at the apex). Host-only cookies then
// never reach the callback and the flow fails with google_failed. Spanning the parent
// domain fixes both legs. Undefined for localhost/IPs, where a Domain attribute breaks.
export function cookieDomain(base: string): string | undefined {
  try {
    const h = new URL(base).hostname
    if (h === 'localhost' || h.endsWith('.localhost') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return undefined
    return `.${h}`
  } catch { return undefined }
}

export function startAuth(clientId: string, redirectUri: string): OauthStart {
  const state = b64u(randomBytes(24))
  const nonce = b64u(randomBytes(24))
  const verifier = b64u(randomBytes(48))
  const challenge = b64u(createHash('sha256').update(verifier).digest())
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  })
  return { url: `${AUTH_URL}?${q}`, cookie: `${state}.${nonce}.${verifier}` }
}

export function parseCookie(c: string | undefined): { state: string; nonce: string; verifier: string } | null {
  const m = /^([\w-]{20,})\.([\w-]{20,})\.([\w-]{40,})$/.exec(c ?? '')
  return m ? { state: m[1], nonce: m[2], verifier: m[3] } : null
}

export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface GoogleIdentity { sub: string; email: string; name: string }
export type VerifyFail = 'bad_token' | 'bad_signature' | 'bad_claims' | 'email_not_verified'

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string }

// Verifies an RS256 Google ID token against Google's published keys.
export async function verifyIdToken(idToken: string, opts: { clientId: string; nonce: string; fetchImpl?: typeof fetch; now?: number }): Promise<GoogleIdentity | VerifyFail> {
  const f = opts.fetchImpl ?? fetch
  const parts = idToken.split('.')
  if (parts.length !== 3) return 'bad_token'
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch { return 'bad_token' }
  if (header.alg !== 'RS256' || !header.kid) return 'bad_signature'
  let jwk: Jwk | undefined
  try {
    const r = await f(JWKS_URL)
    if (!r.ok) return 'bad_signature'
    jwk = ((await r.json()) as { keys: Jwk[] }).keys.find(k => k.kid === header.kid && k.kty === 'RSA')
  } catch { return 'bad_signature' }
  if (!jwk) return 'bad_signature'
  const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))
  if (!ok) return 'bad_signature'
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const aud = claims.aud
  if (typeof claims.iss !== 'string' || !ISSUERS.includes(claims.iss)) return 'bad_claims'
  if (aud !== opts.clientId && !(Array.isArray(aud) && aud.includes(opts.clientId))) return 'bad_claims'
  if (typeof claims.exp !== 'number' || claims.exp <= now) return 'bad_claims'
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, opts.nonce)) return 'bad_claims'
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') return 'bad_claims'
  // Google sends a real boolean; accept only that.
  if (claims.email_verified !== true) return 'email_not_verified'
  return { sub: claims.sub, email: claims.email.trim().toLowerCase().slice(0, 254), name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : '' }
}

export async function exchangeCode(code: string, o: { clientId: string; clientSecret: string; redirectUri: string; verifier: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  const f = o.fetchImpl ?? fetch
  try {
    const r = await f(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: 'authorization_code', code_verifier: o.verifier }),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { id_token?: unknown }
    return typeof j.id_token === 'string' ? j.id_token : null
  } catch { return null }
}

export function migrateOauth(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_identities (
    provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (provider, subject)
  )`)
}

export type Resolved = { user_id: string; created: boolean } | { error: 'email_exists' }

// Returns the user for this Google identity. A new identity creates a new account only when
// no account has that email: linking to an existing email account is refused, because email
// signup does not verify the address, so linking could hand an account to whoever registered
// it first. Google users get a random, unusable password hash.
export async function resolveUser(db: Db, id: GoogleIdentity): Promise<Resolved> {
  // Two callbacks for the same new identity can race on PG; the loser's insert conflicts, its transaction rolls back
  // (RaceLost), and the retry finds the winner's rows.
  class RaceLost extends Error {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.tx(async (t): Promise<Resolved> => {
        const identity = () => t.get<{ user_id: string }>("SELECT user_id FROM oauth_identities WHERE provider='google' AND subject = ?", [id.sub])
        const hit = await identity()
        if (hit) return { user_id: hit.user_id, created: false }
        if (await t.get('SELECT 1 AS x FROM users WHERE email = ?', [id.email])) {
          // On PG each statement sees the latest commit: a concurrent sign-in for this same identity may have committed
          // its user and identity between the two reads above. Look again before calling the email someone else's.
          const late = await identity()
          return late ? { user_id: late.user_id, created: false } : { error: 'email_exists' }
        }
        const uid = randomBytes(16).toString('hex')
        const u = await t.run('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
          [uid, id.email, id.name, '', randomBytes(64).toString('hex'), randomBytes(16).toString('hex')])
        if (u.changes !== 1) throw new RaceLost()
        const o = await t.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?) ON CONFLICT (provider, subject) DO NOTHING", [id.sub, uid])
        if (o.changes !== 1) throw new RaceLost()
        return { user_id: uid, created: true }
      })
    } catch (e) {
      if (!(e instanceof RaceLost)) throw e
    }
  }
  throw new Error('google sign-in: identity kept changing while resolving it')
}
