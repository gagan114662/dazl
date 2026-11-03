// #370: sender identities, the provider-independent model for "who a message goes out from".
//
// A workspace keeps its primary Gmail connection (gmail_accounts, one per tenant, unchanged) and may add further
// sender identities here, one row per verified mailbox. Each identity:
//   - names its provider (only 'gmail' exists today; the CHECK and SENDER_PROVIDERS widen together when a second
//     provider ships with its own contract tests - nothing here assumes Google beyond the adapter in sender-adapters.ts),
//   - was verified by the provider at connect time (verified email from the token response, never typed in),
//   - is owned by the workspace member who connected it: it may send only while that member is still in the workspace
//     with a role that can send (removal or demotion revokes it at the next send, nothing to clean up first),
//   - holds its own encrypted refresh token, bound to (tenant, identity id) - never shared with another identity,
//   - has its own rolling 24h cap with a warm-up ramp, on top of (never instead of) the workspace's shared cap.
// A message bound to an identity (outreach_messages.sender_id) has an approval hash that includes the identity, so
// changing the sender drops the approval. NULL sender_id = the primary connection, exactly the behaviour before #370.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { can, isRole } from '../workspaces.ts'
import { ACCOUNT_SEND_CAP, tableExists } from './send-budget.ts'

export const SENDER_PROVIDERS = ['gmail'] as const
export type SenderProvider = typeof SENDER_PROVIDERS[number]
export const MAX_SENDER_IDENTITIES = 10
// Warm-up: a newly verified mailbox sends at most this many per rolling 24h in its first, second and third week,
// then the full per-identity cap. Applies to added identities only; the primary connection keeps the old rules.
export const SENDER_WARMUP = [5, 10, 15] as const
export const SENDER_IDENTITY_CAP = Math.min(ACCOUNT_SEND_CAP, Number(process.env.OUTREACH_DAILY_CAP || 20))
const WEEK = 7 * 86400

export const SENDER_IDENTITIES_DDL = `
  CREATE TABLE IF NOT EXISTS sender_identities (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    provider        TEXT NOT NULL CHECK (provider IN ('gmail')),
    email           TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
    owner_member_id TEXT NOT NULL,
    refresh_ct      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
    verified_at     INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    UNIQUE (tenant_id, provider, email)
  );
  CREATE INDEX IF NOT EXISTS sender_identities_tenant ON sender_identities (tenant_id, status);
`
export function migrateSenders(db: Database.Database): void {
  db.exec(SENDER_IDENTITIES_DDL)
}

export interface SenderIdentity { id: string; tenant_id: string; provider: SenderProvider; email: string; owner_member_id: string; refresh_ct: string; status: string; verified_at: number }
export class SenderError extends Error {
  code: string
  constructor(code: string) { super(code); this.code = code }
}

export const senderCredentialContext = (tenantId: string, id: string) => `sender-refresh:${tenantId}:${id}`

// Tenant-scoped read; an identity of another workspace is simply not found.
export function senderIdentity(db: Database.Database, tenantId: string, id: string): SenderIdentity | undefined {
  if (!tableExists(db, 'sender_identities')) return undefined
  return db.prepare('SELECT id, tenant_id, provider, email, owner_member_id, refresh_ct, status, verified_at FROM sender_identities WHERE id = ? AND tenant_id = ?').get(id, tenantId) as SenderIdentity | undefined
}

// Insert or refresh a verified identity, called by the provider's connect completion only (the email comes from the
// provider's verified token response). Reconnecting the same mailbox by its owner keeps the id (bound messages keep
// their binding); the same mailbox connected by another member is refused, never silently re-owned.
export function saveSenderIdentity(db: Database.Database, tenantId: string, s: { provider: SenderProvider; email: string; ownerMemberId: string; encrypt: (id: string) => string; now: number }): string {
  return db.transaction(() => {
    const had = db.prepare('SELECT id, owner_member_id FROM sender_identities WHERE tenant_id = ? AND provider = ? AND email = ?').get(tenantId, s.provider, s.email) as { id: string; owner_member_id: string } | undefined
    if (had && had.owner_member_id !== s.ownerMemberId) throw new SenderError('sender_owned_by_other_member')
    if (had) {
      db.prepare("UPDATE sender_identities SET refresh_ct = ?, status = 'active' WHERE id = ? AND tenant_id = ?").run(s.encrypt(had.id), had.id, tenantId)
      return had.id
    }
    const n = (db.prepare('SELECT count(*) AS n FROM sender_identities WHERE tenant_id = ?').get(tenantId) as { n: number }).n
    if (n >= MAX_SENDER_IDENTITIES) throw new SenderError('too_many_senders')
    const id = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO sender_identities (id, tenant_id, provider, email, owner_member_id, refresh_ct, status, verified_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)")
      .run(id, tenantId, s.provider, s.email, s.ownerMemberId, s.encrypt(id), s.now)
    return id
  }).immediate()
}

// The owner's current membership: the identity may send only while its owner is a member who can send. An unreadable
// membership store is a refusal (fail closed), never an implicit grant.
export function senderOwnerMaySend(db: Database.Database, tenantId: string, ownerMemberId: string): boolean {
  try {
    const r = db.prepare('SELECT role FROM memberships WHERE tenant_id = ? AND member_id = ?').get(tenantId, ownerMemberId) as { role: string } | undefined
    return !!r && isRole(r.role) && can(r.role, 'send')
  } catch { return false }
}

// Why this identity cannot send right now, or null. 'sender_disconnected' covers a deleted row (disconnect removes the
// credential with it) and an id from another workspace.
export function senderBlock(db: Database.Database, tenantId: string, id: string): string | null {
  const s = senderIdentity(db, tenantId, id)
  if (!s) return 'sender_disconnected'
  if (s.status !== 'active') return 'sender_reconnect_needed'
  if (!senderOwnerMaySend(db, tenantId, s.owner_member_id)) return 'sender_owner_removed'
  return null
}

// The identity's own 24h limit: its warm-up step, never above the per-identity cap.
export function senderDailyLimit(s: Pick<SenderIdentity, 'verified_at'>, now: number): number {
  const week = Math.max(0, Math.floor((now - Number(s.verified_at)) / WEEK))
  return Math.min(SENDER_IDENTITY_CAP, week < SENDER_WARMUP.length ? SENDER_WARMUP[week] : SENDER_IDENTITY_CAP)
}
// First touches claimed from this identity in the rolling 24h (in-flight and unknown outcomes reserve a slot, like the
// shared budget). Bound messages are first touches only: sequences and follow-ups never run from an added identity.
export function senderSendCount(db: Database.Database, tenantId: string, id: string, now: number): number {
  return (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND sender_id = ? AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenantId, id, now - 86400) as { n: number }).n
}

export interface SenderView { id: string; provider: SenderProvider; email: string; status: string; owner_member_id: string; verified_at: number; usable: string | null; daily_limit: number; sent_24h: number }
// For settings: never the credential.
export function listSenders(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): SenderView[] {
  if (!tableExists(db, 'sender_identities')) return []
  const rows = db.prepare('SELECT id, tenant_id, provider, email, owner_member_id, refresh_ct, status, verified_at FROM sender_identities WHERE tenant_id = ? ORDER BY created_at, id').all(tenantId) as SenderIdentity[]
  return rows.map(s => ({ id: s.id, provider: s.provider, email: s.email, status: s.status, owner_member_id: s.owner_member_id, verified_at: Number(s.verified_at), usable: senderBlock(db, tenantId, s.id), daily_limit: senderDailyLimit(s, now), sent_24h: senderSendCount(db, tenantId, s.id, now) }))
}

export function markSenderNeedsReconnect(db: Database.Database, tenantId: string, id: string): void {
  db.prepare("UPDATE sender_identities SET status = 'needs_reconnect' WHERE id = ? AND tenant_id = ?").run(id, tenantId)
}

// Disconnect removes the identity and its credential. Messages bound to it stay where they are and are refused at
// send ('sender_disconnected') until a person assigns another sender, which needs a fresh approval. Nothing else stops.
export function deleteSenderIdentity(db: Database.Database, tenantId: string, id: string): boolean {
  return db.prepare('DELETE FROM sender_identities WHERE id = ? AND tenant_id = ?').run(id, tenantId).changes === 1
}
