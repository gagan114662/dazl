// Email ownership and account recovery (#357). A password account's email is unverified until its owner opens a
// verification link sent to it; a Google account's email is verified by Google. Recovery is a reset link sent to the
// account's email: it sets a new password, proves the email, and signs the account out everywhere.
//
// Links carry a random 256-bit token; only its SHA-256 is stored. Each token has one purpose, expires, and is used up
// in the transaction that acts on it, so an expired, used or replayed link does nothing. Responses that take an
// email never say whether an account exists for it.
import { createHash, randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { revokeAllSessionsTx } from './sessions.ts'
import { sendSystemMail } from './system-mail.ts'

// SQLite: migrateAuth (lib/auth-db.ts); PG: 0023_email_ownership.sql.
export const EMAIL_TOKENS_DDL = `
  CREATE TABLE IF NOT EXISTS email_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'change')),
    email TEXT NOT NULL CHECK (length(email) <= 254),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens (user_id, purpose);
`
// Google accounts: Google verified the address (lib/auth-google.ts requires email_verified). Same SQL on both engines.
export const VERIFIED_BACKFILL_SQL = `UPDATE users SET email_verified_at = coalesce(created_at, 0)
  WHERE email_verified_at IS NULL AND EXISTS (SELECT 1 FROM oauth_identities o WHERE o.user_id = users.id AND o.provider = 'google')`

type Purpose = 'verify' | 'reset' | 'change'
export const VERIFY_TTL_S = 24 * 60 * 60
export const RESET_TTL_S = 30 * 60
const nowS = () => Math.floor(Date.now() / 1000)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const isEmailToken = (t: unknown): t is string => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t)
const base = () => process.env.PUBLIC_BASE_URL || 'https://dazl.ai'

// A new token for (user, purpose); earlier unused tokens of that purpose stop working.
function* issue(t: Tx, userId: string, purpose: Purpose, email: string, ttl: number, now: number): TxBody<string> {
  // One account lock orders token issue, consumption and recovery on both engines.
  yield* t.run('UPDATE users SET email = email WHERE id = ?', [userId])
  yield* t.run('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [now, userId, purpose])
  const token = randomBytes(32).toString('hex')
  yield* t.run('INSERT INTO email_tokens (id, user_id, purpose, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [randomBytes(12).toString('hex'), userId, purpose, email, sha256(token), now, now + ttl])
  return token
}

// The token's row, used up, when it is valid for `purpose` now; undefined otherwise.
function* consume(t: Tx, purposes: Purpose[], token: string, now: number): TxBody<{ user_id: string; email: string; purpose: Purpose } | undefined> {
  const owner = yield* t.get<{ user_id: string }>('SELECT user_id FROM email_tokens WHERE token_hash = ?', [sha256(token)])
  if (!owner) return undefined
  // Lock account before token row, matching issue(). Re-read after the lock so a
  // recovery that committed while this caller waited invalidates the capability.
  yield* t.run('UPDATE users SET email = email WHERE id = ?', [owner.user_id])
  const row = yield* t.get<{ id: string; user_id: string; email: string; purpose: Purpose }>(
    `SELECT id, user_id, email, purpose FROM email_tokens WHERE token_hash = ? AND purpose IN (${purposes.map(() => '?').join(', ')}) AND used_at IS NULL AND expires_at > ?`, [sha256(token), ...purposes, now])
  if (!row) return undefined
  const used = yield* t.run('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', [now, row.id])
  return used.changes === 1 ? row : undefined
}

export async function emailStatus(db: Db, userId: string): Promise<{ email: string; verified: boolean; google: boolean } | null> {
  const r = await db.get<{ email: string; v: number | null; g: number | null }>(
    "SELECT u.email, u.email_verified_at AS v, (SELECT 1 FROM oauth_identities o WHERE o.user_id = u.id AND o.provider = 'google') AS g FROM users u WHERE u.id = ?", [userId])
  return r ? { email: r.email, verified: r.v !== null, google: !!r.g } : null
}

export async function isEmailVerified(db: Db, userId: string): Promise<boolean> {
  return !!(await db.get('SELECT 1 AS x FROM users WHERE id = ? AND email_verified_at IS NOT NULL', [userId]))
}

// Sends the account a verification link (nothing when it is already verified). Returns whether one was sent.
export async function sendVerification(db: Db, userId: string, now = nowS()): Promise<boolean> {
  const sent = await db.tx(function* (t) {
    const u = yield* t.get<{ email: string; v: number | null }>('SELECT email, email_verified_at AS v FROM users WHERE id = ?', [userId])
    if (!u || u.v !== null) return null
    return { email: u.email, token: yield* issue(t, userId, 'verify', u.email, VERIFY_TTL_S, now) }
  })
  if (!sent) return false
  await sendSystemMail(db, { userId, to: sent.email, subject: 'Confirm your email for dazl',
    text: `Confirm this is your email address for dazl:\n\n${base()}/verify#t=${sent.token}\n\nThe link works once, for 24 hours. If you did not create a dazl account, ignore this email.` })
  return true
}

// Read-only peek at a token's owner (no consumption): routes that act on a successful open need the account
// and address the token bound. Unknown or malformed token: null.
export async function tokenOwner(db: Db, token: unknown): Promise<{ user_id: string; email: string; purpose: Purpose } | null> {
  if (!isEmailToken(token)) return null
  return (await db.get<{ user_id: string; email: string; purpose: Purpose }>('SELECT user_id, email, purpose FROM email_tokens WHERE token_hash = ?', [sha256(token)])) ?? null
}

// Opens a verification link: either the account's own address (valid only while the account still has the email it
// was sent to), or a change of address (the account's email becomes the new one, verified; refused if another account
// took that address meanwhile).
export async function verifyEmail(db: Db, token: unknown, now = nowS()): Promise<boolean> {
  if (!isEmailToken(token)) return false
  try {
    return await db.tx(function* (t) {
      const row = yield* consume(t, ['verify', 'change'], token, now)
      if (!row) return false
      if (row.purpose === 'verify') {
        const r = yield* t.run('UPDATE users SET email_verified_at = coalesce(email_verified_at, ?) WHERE id = ? AND email = ?', [now, row.user_id, row.email])
        return r.changes === 1
      }
      if (yield* t.get('SELECT 1 AS x FROM users WHERE email = ? AND id <> ?', [row.email, row.user_id])) return false
      const r = yield* t.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [row.email, now, row.user_id])
      return r.changes === 1
    })
  } catch { return false } // a concurrent sign-up took the new address: the unique email refused the change, nothing changed
}

// Change of email, from a signed-in, freshly authenticated session: a confirmation link goes to the NEW address and a
// notice to the current one; nothing changes until the link is opened. The same outcome for the caller whether or not
// the new address already belongs to an account (then nothing is sent to it), so this reveals no accounts.
export async function requestEmailChange(db: Db, userId: string, newEmail: string, now = nowS(), sessionToken?: string): Promise<void> {
  const out = await db.tx(function* (t) {
    yield* t.run('UPDATE users SET email = email WHERE id = ?', [userId])
    if (sessionToken !== undefined) {
      if (!isEmailToken(sessionToken) || !(yield* t.get('SELECT 1 AS x FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ? AND authed_at >= ?', [sha256(sessionToken), userId, now, now - 3600]))) return null
    }
    const u = yield* t.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])
    if (!u || u.email === newEmail) return null
    const taken = !!(yield* t.get('SELECT 1 AS x FROM users WHERE email = ?', [newEmail]))
    return { old: u.email, token: taken ? null : yield* issue(t, userId, 'change', newEmail, VERIFY_TTL_S, now) }
  })
  if (!out) return
  if (out.token) await sendSystemMail(db, { userId, to: newEmail, subject: 'Confirm your new email for dazl',
    text: `Confirm that this is the new email address of your dazl account:\n\n${base()}/verify#t=${out.token}\n\nThe link works once, for 24 hours. If you did not ask for this, ignore this email.` })
  await sendSystemMail(db, { userId, to: out.old, subject: 'Your dazl email is being changed',
    text: `Someone signed in to your dazl account asked to change its email address. It changes only once the new address is confirmed. If it was not you, reset your password at ${base()}/reset and sign out other devices in Settings.` })
}

// "Forgot password": always the same outcome for the caller. A password account gets a reset link; a Google-only
// account gets a note to sign in with Google (setting a password there would add a way in that Google does not guard);
// an unknown email gets nothing.
export async function requestReset(db: Db, email: string, now = nowS()): Promise<void> {
  const out = await db.tx(function* (t) {
    const u = yield* t.get<{ id: string; email: string; g: number | null }>(
      "SELECT u.id, u.email, (SELECT 1 FROM oauth_identities o WHERE o.user_id = u.id AND o.provider = 'google') AS g FROM users u WHERE u.email = ?", [email])
    if (!u) return null
    if (u.g) return { userId: u.id, to: u.email, token: null }
    return { userId: u.id, to: u.email, token: yield* issue(t, u.id, 'reset', u.email, RESET_TTL_S, now) }
  })
  if (!out) return
  await sendSystemMail(db, out.token
    ? { userId: out.userId, to: out.to, subject: 'Reset your dazl password', text: `Someone asked to reset the password of your dazl account. To choose a new one:\n\n${base()}/reset#t=${out.token}\n\nThe link works once, for 30 minutes, and signs your account out everywhere. If it was not you, ignore this email: your password stays as it is.` }
    : { userId: out.userId, to: out.to, subject: 'Signing in to dazl', text: `Someone asked to reset the password of your dazl account. Your account signs in with Google, so there is no password to reset: use "Continue with Google" at ${base()}/sign-in.` })
}

// Opens a reset link: sets the new password (hash computed by the caller), proves the email, uses up every other
// account capability (including a pending address change), and revokes every session of the account. false: the link is not valid (expired, used, unknown).
export async function resetPassword(db: Db, token: unknown, next: { password_hash: string; salt: string }, now = nowS()): Promise<boolean> {
  if (!isEmailToken(token)) return false
  return db.tx(function* (t) {
    const row = yield* consume(t, ['reset'], token, now)
    if (!row) return false
    const r = yield* t.run('UPDATE users SET password_hash = ?, salt = ?, email_verified_at = coalesce(email_verified_at, ?) WHERE id = ? AND email = ?',
      [next.password_hash, next.salt, now, row.user_id, row.email])
    if (r.changes !== 1) return false
    yield* t.run("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL", [now, row.user_id])
    yield* revokeAllSessionsTx(t, row.user_id, { by: row.user_id, reason: 'recovery', now })
    return true
  })
}
