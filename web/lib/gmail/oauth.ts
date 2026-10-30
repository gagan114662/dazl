import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'
import type Database from 'better-sqlite3'
import { decryptSecret, encryptSecret } from '../secrets.ts'
import { norm } from '../outreach/store.ts'
import { isStaging, STUB_SENDER } from '../staging.ts'

// Least privilege: send is the required grant. Reading replies is a separate, optional gmail.readonly grant (below).
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
// Reading is a separate, optional grant. gmail.readonly is the narrowest scope that returns message bodies.
// dazl only ever opens threads it started itself (by thread id) and never lists or searches the mailbox.
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE]
const STATE_TTL_S = 600

export interface OAuthEnv { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; PUBLIC_BASE_URL?: string }
export interface OAuthDeps { withRead?: boolean; env?: OAuthEnv; fetchImpl?: typeof fetch; master?: Buffer; now?: number }

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
  if (isStaging(env as Record<string, string | undefined>)) return connectStub(db, tenantId, env, deps)
  const c = creds(env)
  const state = randomBytes(24).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const t = nowS(deps)
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(t)
  db.prepare('INSERT INTO oauth_states (state_hash, tenant_id, verifier, expires_at, read_scope) VALUES (?, ?, ?, ?, ?)').run(sha(state), tenantId, verifier, t + STATE_TTL_S, deps.withRead ? 1 : 0)
  const q = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: (deps.withRead ? [...SCOPES, GMAIL_READ_SCOPE] : SCOPES).join(' '),
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
  const row = db.prepare('SELECT tenant_id, verifier, expires_at, read_scope FROM oauth_states WHERE state_hash = ?').get(sha(state)) as { tenant_id: string; verifier: string; expires_at: number; read_scope: number } | undefined
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
  // Google's granular consent lets the user untick the read scope on the consent screen.
  // That is a valid choice: the connection still works send-only, and read_granted records
  // what was actually granted. Only a missing send scope is a failure (handled above).
  const readGranted = (t.scope ?? '').split(' ').includes(GMAIL_READ_SCOPE)
  const who = t.id_token ? idTokenEmail(t.id_token) : null
  if (!who || !who.verified) throw new GmailError('google', 'email_not_verified')

  // Another Gmail address replaces this tenant's sender (#370): every approval still waiting was for the old one, so it
  // goes back to draft before the new account can send anything. The same address reconnecting keeps them.
  const before = (db.prepare('SELECT email FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string } | undefined)?.email
  if (before && before.toLowerCase() !== who.email.toLowerCase()) revokeApprovalsForSender(db, tenantId)
  db.prepare(
    `INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES (?, ?, ?, 'active', ?)
     ON CONFLICT(tenant_id) DO UPDATE SET email = excluded.email, refresh_ct = excluded.refresh_ct, status = 'active', read_granted = excluded.read_granted, connected_at = CAST(strftime('%s','now') AS INTEGER)`,
  ).run(tenantId, who.email, encryptSecret(t.refresh_token, ctx(tenantId), deps.master), readGranted ? 1 : 0)
  return { email: who.email }
}

// Staging only (lib/staging.ts): connect a stub account straight away, with no Google round trip. The stored token is a
// placeholder that is never sent anywhere: getAccessToken and gmailSend do not call Google in staging.
function connectStub(db: Database.Database, tenantId: string, env: OAuthEnv, deps: OAuthDeps): string {
  db.prepare(
    `INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES (?, ?, ?, 'active', 1)
     ON CONFLICT(tenant_id) DO UPDATE SET status = 'active', read_granted = 1`,
  ).run(tenantId, STUB_SENDER(tenantId), encryptSecret('staging-stub', ctx(tenantId), deps.master))
  return `${(env.PUBLIC_BASE_URL || 'https://staging.dazl.ai').replace(/\/$/, '')}/app/settings?gmail=connected`
}

const GMAIL_STATUS_SQL = 'SELECT email, status, read_granted FROM gmail_accounts WHERE tenant_id = ?'
type GmailStatusRow = { email: string; status: string; read_granted: number }
const gmailStatusOf = (r: GmailStatusRow | undefined) => r ? { email: r.email, status: r.status, read_granted: Number(r.read_granted) === 1 } : null
export function gmailStatus(db: Database.Database, tenantId: string): { email: string; status: string; read_granted: boolean } | null {
  return gmailStatusOf(db.prepare(GMAIL_STATUS_SQL).get(tenantId) as GmailStatusRow | undefined)
}
// gmailStatus on the Db layer (SQLite or Postgres).
export async function readGmailStatus(db: Db, tenantId: string): Promise<{ email: string; status: string; read_granted: boolean } | null> {
  return gmailStatusOf(await db.get<GmailStatusRow>(GMAIL_STATUS_SQL, [tenantId]))
}

// Short-lived access token from the stored refresh token. A revoked or expired
// grant flips the account to needs_reconnect so nothing keeps trying to send.
export async function getAccessToken(db: Database.Database, tenantId: string, deps: OAuthDeps = {}): Promise<string> {
  const env: OAuthEnv = deps.env ?? (process.env as OAuthEnv)
  const staging = isStaging(env as Record<string, string | undefined>)
  const c = staging ? null : creds(env)
  const acc = db.prepare('SELECT refresh_ct, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { refresh_ct: string; status: string } | undefined
  if (!acc || acc.status !== 'active') throw new GmailError('reconnect', 'not_connected')
  if (staging || !c) return STAGING_TOKEN
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

// Approvals given for the sender being replaced or removed. Revoke: back to draft (a person approves again for the new
// sender). Bind: approvals recorded before the binding existed are tied to the departing address, so a different
// account connected later cannot inherit them. Tables an older database does not have hold nothing.
function hasTable(db: Database.Database, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) }
function revokeApprovalsForSender(db: Database.Database, tenantId: string): void {
  db.prepare("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL, approved_sender = NULL, error = 'sender_changed' WHERE tenant_id = ? AND status = 'approved'").run(tenantId)
  if (hasTable(db, 'sequence_steps')) {
    db.prepare("UPDATE sequence_steps SET status = 'draft', approved_hash = NULL, approved_sender = NULL WHERE tenant_id = ? AND status = 'approved'").run(tenantId)
    db.prepare("UPDATE sequences SET status = 'draft' WHERE tenant_id = ? AND status = 'approved'").run(tenantId)
  }
}
function bindApprovalsToSender(db: Database.Database, tenantId: string, email: string): void {
  db.prepare("UPDATE outreach_messages SET approved_sender = lower(?) WHERE tenant_id = ? AND status = 'approved' AND approved_sender IS NULL").run(email, tenantId)
  if (hasTable(db, 'sequence_steps')) db.prepare("UPDATE sequence_steps SET approved_sender = lower(?) WHERE tenant_id = ? AND status = 'approved' AND approved_sender IS NULL").run(email, tenantId)
}

export async function disconnectGmail(db: Database.Database, tenantId: string, deps: OAuthDeps = {}): Promise<void> {
  const acc = db.prepare('SELECT refresh_ct, email FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { refresh_ct: string; email: string } | undefined
  if (!acc) return
  bindApprovalsToSender(db, tenantId, acc.email)
  if (isStaging((deps.env ?? process.env) as Record<string, string | undefined>)) { db.prepare('DELETE FROM gmail_accounts WHERE tenant_id = ?').run(tenantId); return }
  try {
    const token = decryptSecret(acc.refresh_ct, ctx(tenantId), deps.master)
    await (deps.fetchImpl ?? fetch)('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) })
  } catch {
    // best effort: the local copy is deleted either way
  }
  db.prepare('DELETE FROM gmail_accounts WHERE tenant_id = ?').run(tenantId)
}

// In staging (or with the stub token) nothing is sent: the message gets a stub id and its thread, as Gmail would return.
const STAGING_TOKEN = 'staging-stub-token'
export async function gmailSend(accessToken: string, raw: string, fetchImpl: typeof fetch = fetch, threadId?: string): Promise<{ id: string; threadId?: string }> {
  if (accessToken === STAGING_TOKEN || isStaging()) {
    const id = `stub${randomBytes(8).toString('hex')}`
    return { id, threadId: threadId ?? id }
  }
  const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new GmailSendError(res.status)
  // A 2xx is not proof of handoff: the body must carry the provider's message id. Anything else is an UNKNOWN outcome
  // (the mail may or may not have gone out), never "sent" and never safe to retry blindly.
  let j: unknown
  try { j = await res.json() } catch { throw new GmailUnconfirmedSend('invalid_json') }
  return confirmedSendResult(j)
}

// The only shape that counts as a confirmed Gmail handoff: an object with a non-blank string message id (Gmail ids are short
// hex strings; the pattern is deliberately loose about case and length but refuses whitespace, URLs and anything odd).
// A threadId that is missing or not a usable string is dropped, never guessed. Used by gmailSend and by every caller that takes
// an injectable send function, so a test double or a future transport cannot slip an unverified result into a 'sent' row.
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/
export function confirmedSendResult(r: unknown): { id: string; threadId?: string } {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new GmailUnconfirmedSend('not_an_object')
  const o = r as { id?: unknown; threadId?: unknown }
  if (typeof o.id !== 'string') throw new GmailUnconfirmedSend(o.id === undefined ? 'missing_id' : 'id_wrong_type')
  const id = o.id.trim()
  if (!MESSAGE_ID.test(id)) throw new GmailUnconfirmedSend(id === '' ? 'blank_id' : 'id_malformed')
  const t = typeof o.threadId === 'string' ? o.threadId.trim() : ''
  return MESSAGE_ID.test(t) ? { id, threadId: t } : { id }
}

// The HTTP call succeeded but the response did not confirm the handoff. Deliberately NOT a GmailSendError: callers treat any
// non-GmailSendError as an uncertain outcome (claim kept, tenant sending paused for review, no automatic retry).
export class GmailUnconfirmedSend extends Error {
  reason: string
  constructor(reason: string) { super(`gmail_unconfirmed:${reason}`); this.reason = reason }
}

export class GmailSendError extends Error {
  status: number
  constructor(status: number) {
    super(`gmail_${status}`)
    this.status = status
  }
}
