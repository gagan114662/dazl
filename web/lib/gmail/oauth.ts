import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { decryptSecret, encryptSecret } from '../secrets.ts'
import { norm } from '../outreach/store.ts'

// Least privilege: send only. dazl can never read the user's mailbox.
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
const SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE]
const STATE_TTL_S = 600

export interface OAuthEnv { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; PUBLIC_BASE_URL?: string }
export interface OAuthDeps { env?: OAuthEnv; fetchImpl?: typeof fetch; master?: Buffer; now?: number }

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const nowS = (d: OAuthDeps) => d.now ?? Math.floor(Date.now() / 1000)
const ctx = (tenantId: string) => `gmail-refresh:${tenantId}`

export class GmailError extends Error {
  kind: 'config' | 'state' | 'google' | 'reconnect' | 'retry'
  constructor(kind: GmailError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

export function redirectUri(env: OAuthEnv): string {
  return `${(env.PUBLIC_BASE_URL || 'https://dazl.ai').replace(/\/$/, '')}/api/gmail/callback`
}

function creds(env: OAuthEnv) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new GmailError('config', 'google_not_configured')
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
}

// Authorization code flow with PKCE and a one-time state bound to the signed-in user.
export function startOAuth(db: Database.Database, tenantId: string, deps: OAuthDeps = {}): string {
  const env: OAuthEnv = deps.env ?? (process.env as OAuthEnv)
  const c = creds(env)
  const state = randomBytes(24).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const t = nowS(deps)
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(t)
  db.prepare('INSERT INTO oauth_states (state_hash, tenant_id, verifier, expires_at) VALUES (?, ?, ?, ?)').run(sha(state), tenantId, verifier, t + STATE_TTL_S)
  const q = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

function idTokenEmail(idToken: string): { email: string; verified: boolean } | null {
  try {
    const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as { email?: string; email_verified?: boolean }
    // Received straight from Google's token endpoint over TLS, so the payload is trusted without re-checking the signature.
    return p.email ? { email: norm(p.email), verified: p.email_verified === true } : null
  } catch {
    return null
  }
}

export async function completeOAuth(db: Database.Database, tenantId: string, code: string, state: string, deps: OAuthDeps = {}): Promise<{ email: string }> {
  const env: OAuthEnv = deps.env ?? (process.env as OAuthEnv)
  const c = creds(env)
  const row = db.prepare('SELECT tenant_id, verifier, expires_at FROM oauth_states WHERE state_hash = ?').get(sha(state)) as { tenant_id: string; verifier: string; expires_at: number } | undefined
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(sha(state)) // one use, even on failure
  if (!row || row.tenant_id !== tenantId || row.expires_at < nowS(deps)) throw new GmailError('state', 'bad_state')

  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri(env), grant_type: 'authorization_code', code_verifier: row.verifier }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new GmailError('retry', 'network')
  }
  if (!res.ok) throw new GmailError('google', 'code_exchange_failed')
  const t = (await res.json()) as { refresh_token?: string; scope?: string; id_token?: string }
  if (!t.refresh_token) throw new GmailError('google', 'no_refresh_token')
  if (!(t.scope ?? '').split(' ').includes(GMAIL_SEND_SCOPE)) throw new GmailError('google', 'send_scope_not_granted')
  const who = t.id_token ? idTokenEmail(t.id_token) : null
  if (!who || !who.verified) throw new GmailError('google', 'email_not_verified')

  db.prepare(
    `INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES (?, ?, ?, 'active')
     ON CONFLICT(tenant_id) DO UPDATE SET email = excluded.email, refresh_ct = excluded.refresh_ct, status = 'active', connected_at = CAST(strftime('%s','now') AS INTEGER)`,
  ).run(tenantId, who.email, encryptSecret(t.refresh_token, ctx(tenantId), deps.master))
  return { email: who.email }
}

export function gmailStatus(db: Database.Database, tenantId: string): { email: string; status: string } | null {
  return (db.prepare('SELECT email, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; status: string } | undefined) ?? null
}

// Short-lived access token from the stored refresh token. A revoked or expired
// grant flips the account to needs_reconnect so nothing keeps trying to send.
export async function getAccessToken(db: Database.Database, tenantId: string, deps: OAuthDeps = {}): Promise<string> {
  const env: OAuthEnv = deps.env ?? (process.env as OAuthEnv)
  const c = creds(env)
  const acc = db.prepare('SELECT refresh_ct, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { refresh_ct: string; status: string } | undefined
  if (!acc || acc.status !== 'active') throw new GmailError('reconnect', 'not_connected')
  const refresh = decryptSecret(acc.refresh_ct, ctx(tenantId), deps.master)
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: refresh, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new GmailError('retry', 'network')
  }
  if (res.status === 400 || res.status === 401) {
    const j = (await res.json().catch(() => ({}))) as { error?: string }
    if (j.error === 'invalid_grant' || res.status === 401) {
      db.prepare("UPDATE gmail_accounts SET status = 'needs_reconnect' WHERE tenant_id = ?").run(tenantId)
      throw new GmailError('reconnect', 'grant_revoked')
    }
  }
  if (!res.ok) throw new GmailError('retry', `token_${res.status}`)
  const j = (await res.json()) as { access_token?: string }
  if (!j.access_token) throw new GmailError('retry', 'no_access_token')
  return j.access_token
}

export async function disconnectGmail(db: Database.Database, tenantId: string, deps: OAuthDeps = {}): Promise<void> {
  const acc = db.prepare('SELECT refresh_ct FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { refresh_ct: string } | undefined
  if (!acc) return
  try {
    const token = decryptSecret(acc.refresh_ct, ctx(tenantId), deps.master)
    await (deps.fetchImpl ?? fetch)('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) })
  } catch {
    // best effort: the local copy is deleted either way
  }
  db.prepare('DELETE FROM gmail_accounts WHERE tenant_id = ?').run(tenantId)
}

export async function gmailSend(accessToken: string, raw: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string }> {
  const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new GmailSendError(res.status)
  const j = (await res.json().catch(() => ({}))) as { id?: string }
  return { id: j.id ?? '' }
}

export class GmailSendError extends Error {
  status: number
  constructor(status: number) {
    super(`gmail_${status}`)
    this.status = status
  }
}
