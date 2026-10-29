// Session inventory, revocation and expiry cleanup (#358). The cookie holds a random token; the sessions row holds its
// SHA-256 as the key and a separate random public_id, the only handle the UI and the API ever show. A revoked session
// keeps its row (who revoked it, when, why) until the reaper's retention ends; getSessionUser refuses it at once, on
// every instance, because the check is that row in the shared store.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { recordTx } from './audit.ts'

export const SESSION_COLUMNS = [
  'ALTER TABLE sessions ADD COLUMN public_id TEXT',
  'ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER',
  'ALTER TABLE sessions ADD COLUMN device TEXT',
  'ALTER TABLE sessions ADD COLUMN revoked_at INTEGER',
  'ALTER TABLE sessions ADD COLUMN revoked_by TEXT',
  'ALTER TABLE sessions ADD COLUMN revoke_reason TEXT',
  // when this session last proved who it is (sign-in, or re-authentication); PG: 0017_session_fresh_auth.sql
  'ALTER TABLE sessions ADD COLUMN authed_at INTEGER',
]
// A session older than this since its last sign-in must re-authenticate before changing secrets, billing or members.
export const FRESH_AUTH_S = 60 * 60
export const SESSION_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions (public_id);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
`
export type RevokeReason = 'signed_out' | 'revoked' | 'revoked_all' | 'recovery' | 'offboarded'

// Revoked and expired rows are kept this long (for "who signed this device out, and when"), then reaped.
export const SESSION_RETAIN_S = 30 * 24 * 60 * 60
// last_seen_at is written at most this often per session, so a busy session costs one write per window, not per call.
export const SEEN_EVERY_S = 5 * 60
const nowS = () => Math.floor(Date.now() / 1000)
export const newPublicId = () => randomBytes(12).toString('hex')
export const isPublicId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v)

// A coarse device label from the User-Agent ("Chrome on macOS"); the raw header is never stored.
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? ''
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : ''
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : ''
  return browser && os ? `${browser} on ${os}` : browser || os || 'Unknown device'
}

export type SessionRow = { public_id: string; created_at: number; last_seen_at: number | null; device: string; current: boolean }

// The account's sessions that still work, newest activity first. Never a token or its hash.
export async function listSessions(db: Db, userId: string, currentHash: string | null, now = nowS()): Promise<SessionRow[]> {
  const rows = await db.all<{ id: string; public_id: string; created_at: number; last_seen_at: number | null; device: string | null }>(
    `SELECT id, public_id, created_at, last_seen_at, device FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY coalesce(last_seen_at, created_at) DESC, public_id`, [userId, now])
  return rows.map(r => ({ public_id: r.public_id, created_at: Number(r.created_at), last_seen_at: r.last_seen_at === null ? null : Number(r.last_seen_at), device: r.device || 'Unknown device', current: r.id === currentHash }))
}

// One of the account's own sessions, by its public id. false: no such working session of this account. Account events
// are recorded in the account's personal workspace (its id is the user id).
export async function revokeSession(db: Db, userId: string, publicId: string, by: string, reason: RevokeReason = 'revoked', now = nowS(), correlationId?: string | null): Promise<boolean> {
  if (!isPublicId(publicId)) return false
  return db.tx(function* (t) {
    const r = yield* t.run('UPDATE sessions SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE public_id = ? AND user_id = ? AND revoked_at IS NULL',
      [now, by, reason, publicId, userId])
    if (r.changes !== 1) return false
    yield* recordTx(t, { tenantId: userId, actorId: by, correlationId, action: 'session.revoked', resourceType: 'session', resourceId: publicId, summary: { reason } }, now)
    return true
  })
}

// Every working session of the account, except `keepHash` when given (sign out everywhere else). Also the step
// account recovery and offboarding take (#357). Returns how many were revoked.
export function* revokeAllSessionsTx(t: Tx, userId: string, o: { by: string; reason: RevokeReason; keepHash?: string | null; now?: number; correlationId?: string | null }): TxBody<number> {
  const now = o.now ?? nowS()
  const r = yield* t.run('UPDATE sessions SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
    [now, o.by, o.reason, userId, o.keepHash ?? ''])
  yield* recordTx(t, { tenantId: userId, actorId: o.by, correlationId: o.correlationId, action: 'session.revoked_all', resourceType: 'account', resourceId: userId, summary: { reason: o.reason, revoked: r.changes, kept_current: !!o.keepHash } }, now)
  return r.changes
}
export function revokeAllSessions(db: Db, userId: string, o: { by: string; reason: RevokeReason; keepHash?: string | null; now?: number; correlationId?: string | null }): Promise<number> {
  return db.tx(t => revokeAllSessionsTx(t, userId, o))
}

type Fence = (t: Tx) => TxBody<void>
const noFence: Fence = function* () { /* not fenced */ }

// Deletes at most `limit` rows that expired or were revoked more than SESSION_RETAIN_S ago. A working session (not
// revoked, not expired) never matches. Run from the scheduled tick (fenced by its lease); a backlog drains over ticks.
export async function reapSessions(db: Db, o: { now?: number; limit?: number; fence?: Fence } = {}): Promise<number> {
  const cutoff = (o.now ?? nowS()) - SESSION_RETAIN_S, limit = Math.max(1, Math.min(o.limit ?? 500, 5000)), fence = o.fence ?? noFence
  return db.tx(function* (t) {
    yield* fence(t)
    const r = yield* t.run(`DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions WHERE expires_at <= ? OR revoked_at <= ? ORDER BY expires_at LIMIT ?)`, [cutoff, cutoff, limit])
    return r.changes
  })
}
