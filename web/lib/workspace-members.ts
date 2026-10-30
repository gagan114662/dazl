// Members of a workspace: invitations, role changes, removal, leaving, and which workspace a session acts in
// (docs/design/workspaces.md, increment 3). Every write runs in one transaction that first locks the workspace row, so
// two concurrent changes cannot both see "another owner remains" and leave the workspace without one.
import { createHash, randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { can, isRole } from './workspaces.ts'
import type { Role } from './workspaces.ts'

// SQLite: migrateAuth (lib/auth-db.ts); PG: 0019_invitations.sql. Only the token's SHA-256 is stored; the token itself
// is shown once, to the inviter, inside the link they share.
export const INVITATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    email TEXT NOT NULL CHECK (length(email) <= 254),
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS invitations_tenant ON invitations (tenant_id, created_at);
`

export const INVITE_TTL_S = 7 * 24 * 60 * 60
export const MAX_PENDING_INVITES = 50
const nowS = () => Math.floor(Date.now() / 1000)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const isInviteToken = (t: unknown): t is string => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t)

type MemberErrorCode = 'forbidden' | 'not_found' | 'last_owner' | 'only_workspace' | 'already_member' | 'too_many_invites' | 'invalid_invite' | 'wrong_account'
export class MemberError extends Error {
  readonly code: MemberErrorCode
  constructor(code: MemberErrorCode) { super(code); this.code = code }
}
export const MEMBER_ERROR_STATUS: Record<MemberError['code'], number> = {
  forbidden: 403, not_found: 404, last_owner: 409, only_workspace: 409, already_member: 409, too_many_invites: 429, invalid_invite: 410, wrong_account: 403,
}

// The acting member: who, in which workspace, as what (from getSessionUser, never from the request).
export type Acting = { actorId: string; tenantId: string; role: Role }

// Serializes member and invitation changes per workspace: PG holds this row lock until commit; SQLite transactions are
// already serialized (IMMEDIATE). Every write takes it first (the one lock order), then reads the acting member's current
// role (actingRole), the target and the owner count, so none of them can change under the decision.
function* lockWorkspace(t: Tx, tenantId: string): TxBody<void> {
  const r = yield* t.run('UPDATE organizations SET name = name WHERE id = ?', [tenantId])
  if (r.changes !== 1) throw new MemberError('not_found')
}

// The acting member's role NOW, read under the workspace lock: never the snapshot the request authenticated with. A
// member demoted or removed while their request waited for the lock acts with their new role, or not at all.
function* actingRole(t: Tx, by: Acting): TxBody<Role> {
  yield* lockWorkspace(t, by.tenantId)
  const r = yield* roleOf(t, by.tenantId, by.actorId)
  if (!r) throw new MemberError('forbidden')
  return r
}

function* roleOf(t: Tx, tenantId: string, memberId: string): TxBody<Role | null> {
  const r = (yield* t.get<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = ? AND member_id = ?', [tenantId, memberId]))?.role
  return isRole(r) ? r : null
}

// A member is never left with no workspace at all: getSessionUser would then find nothing on every request, and the
// account could not sign in to anything (its personal workspace is not recreated once it exists). The count spans every
// workspace, so the account's own row is locked first (after this workspace's lock; one workspace per transaction, so
// the order cannot cycle): two removals or leaves in two workspaces at once then count one after the other.
function* lastWorkspace(t: Tx, memberId: string): TxBody<boolean> {
  yield* t.run('UPDATE users SET id = id WHERE id = ?', [memberId])
  return Number((yield* t.get<{ n: number }>('SELECT count(*) AS n FROM memberships WHERE member_id = ?', [memberId]))?.n ?? 0) <= 1
}

function* owners(t: Tx, tenantId: string): TxBody<number> {
  return Number((yield* t.get<{ n: number }>("SELECT count(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'owner'", [tenantId]))?.n ?? 0)
}

// Granting or touching the owner role takes 'owners'; everything else 'members'.
const mayManage = (who: Role, target: Role | null, next: Role | null) =>
  can(who, 'members') && (target !== 'owner' && next !== 'owner' || can(who, 'owners'))

export async function listMembers(db: Db, tenantId: string) {
  return db.all<{ member_id: string; email: string; name: string | null; role: Role; created_at: number }>(
    `SELECT m.member_id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.member_id
     WHERE m.tenant_id = ? ORDER BY m.created_at, m.member_id`, [tenantId])
}

// The workspaces an account belongs to (for the switcher), its own first. Names only; nothing of their data.
export async function listWorkspaces(db: Db, actorId: string) {
  return db.all<{ tenant_id: string; name: string; kind: string; role: Role }>(
    `SELECT o.id AS tenant_id, o.name, o.kind, m.role FROM memberships m JOIN organizations o ON o.id = m.tenant_id
     WHERE m.member_id = ? ORDER BY CASE WHEN o.id = m.member_id THEN 0 ELSE 1 END, m.created_at, o.id`, [actorId])
}

export async function changeRole(db: Db, by: Acting, memberId: string, role: Role): Promise<void> {
  await db.tx(function* (t) {
    const me = yield* actingRole(t, by)
    const current = yield* roleOf(t, by.tenantId, memberId)
    if (!current) throw new MemberError('not_found')
    if (!mayManage(me, current, role)) throw new MemberError('forbidden')
    if (current === 'owner' && role !== 'owner' && (yield* owners(t, by.tenantId)) <= 1) throw new MemberError('last_owner')
    yield* t.run('UPDATE memberships SET role = ? WHERE tenant_id = ? AND member_id = ?', [role, by.tenantId, memberId])
  })
}

// Removing someone else; leaving is leave(). Access ends on the member's next request: getSessionUser reads the row.
export async function removeMember(db: Db, by: Acting, memberId: string): Promise<void> {
  if (memberId === by.actorId) throw new MemberError('forbidden')
  await db.tx(function* (t) {
    const me = yield* actingRole(t, by)
    const current = yield* roleOf(t, by.tenantId, memberId)
    if (!current) throw new MemberError('not_found')
    if (!mayManage(me, current, null)) throw new MemberError('forbidden')
    if (current === 'owner' && (yield* owners(t, by.tenantId)) <= 1) throw new MemberError('last_owner')
    if (yield* lastWorkspace(t, memberId)) throw new MemberError('only_workspace')
    yield* t.run('DELETE FROM memberships WHERE tenant_id = ? AND member_id = ?', [by.tenantId, memberId])
  })
}

export async function leave(db: Db, by: Acting): Promise<void> {
  await db.tx(function* (t) {
    yield* lockWorkspace(t, by.tenantId)
    const current = yield* roleOf(t, by.tenantId, by.actorId)
    if (!current) throw new MemberError('not_found')
    if (current === 'owner' && (yield* owners(t, by.tenantId)) <= 1) throw new MemberError('last_owner')
    if (yield* lastWorkspace(t, by.actorId)) throw new MemberError('only_workspace')
    yield* t.run('DELETE FROM memberships WHERE tenant_id = ? AND member_id = ?', [by.tenantId, by.actorId])
    // the account's own sessions stop pointing at the workspace it left, so its next request acts in another one. A
    // removed member's sessions are not touched: their next request is refused once (getSessionUser), so a request meant
    // for the old workspace never lands in a different one.
    yield* t.run('UPDATE sessions SET active_tenant_id = NULL WHERE user_id = ? AND active_tenant_id = ?', [by.actorId, by.tenantId])
  })
}

// A new invitation for `email` (lowercased by the caller's validateEmail). A pending invitation for the same email is
// replaced, so only the newest link works. Returns the raw token once; only its hash is stored.
export async function createInvitation(db: Db, by: Acting, email: string, role: Role, now = nowS()): Promise<{ id: string; token: string; expires_at: number }> {
  if (!mayManage(by.role, null, role)) throw new MemberError('forbidden') // fast refusal; re-checked under the lock
  const token = randomBytes(32).toString('hex'), id = randomBytes(12).toString('hex')
  await db.tx(function* (t) {
    const me = yield* actingRole(t, by)
    if (!mayManage(me, null, role)) throw new MemberError('forbidden')
    if (yield* t.get('SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.member_id WHERE m.tenant_id = ? AND lower(u.email) = ?', [by.tenantId, email])) throw new MemberError('already_member')
    // replacing a pending invitation revokes it, so it takes what revoking it would (an owner invitation: 'owners')
    for (const p of yield* t.all<{ role: string }>('SELECT role FROM invitations WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [by.tenantId, email, now]))
      if (!isRole(p.role) || !mayManage(me, null, p.role)) throw new MemberError('forbidden')
    yield* t.run('UPDATE invitations SET revoked_at = ? WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL', [now, by.tenantId, email])
    const pending = Number((yield* t.get<{ n: number }>('SELECT count(*) AS n FROM invitations WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [by.tenantId, now]))?.n ?? 0)
    if (pending >= MAX_PENDING_INVITES) throw new MemberError('too_many_invites')
    yield* t.run('INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, by.tenantId, email, role, sha256(token), by.actorId, now, now + INVITE_TTL_S])
  })
  return { id, token, expires_at: now + INVITE_TTL_S }
}

// Pending invitations, for the workspace's admins. Never the token or its hash.
export async function listInvitations(db: Db, tenantId: string, now = nowS()) {
  return db.all<{ id: string; email: string; role: Role; created_at: number; expires_at: number }>(
    'SELECT id, email, role, created_at, expires_at FROM invitations WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, id',
    [tenantId, now])
}

export async function revokeInvitation(db: Db, by: Acting, id: string, now = nowS()): Promise<void> {
  await db.tx(function* (t) {
    const me = yield* actingRole(t, by)
    const inv = yield* t.get<{ role: string }>('SELECT role FROM invitations WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', [id, by.tenantId])
    if (!inv || !isRole(inv.role)) throw new MemberError('not_found')
    if (!mayManage(me, null, inv.role)) throw new MemberError('forbidden')
    yield* t.run('UPDATE invitations SET revoked_at = ? WHERE id = ? AND tenant_id = ?', [now, id, by.tenantId])
  })
}

// Accepting: the signed-in account must hold the link (the token) and be the account it was sent to (its email). The
// token is used up in the same transaction that adds the membership, so a replay, an expired or a revoked link adds
// nothing. Unknown, used, revoked and expired links all answer the same 'invalid_invite', and so does a link whose
// inviter can no longer grant its role (removed, or demoted below it): a link carries its inviter's authority, so it
// ends with it. An account already in the workspace keeps its role.
export async function acceptInvitation(db: Db, actor: { actorId: string; email: string }, token: string, now = nowS()): Promise<{ tenantId: string; role: Role }> {
  if (!isInviteToken(token)) throw new MemberError('invalid_invite')
  return db.tx(function* (t) {
    const inv = yield* t.get<{ id: string; tenant_id: string; email: string; role: string; invited_by: string }>(
      'SELECT id, tenant_id, email, role, invited_by FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [sha256(token), now])
    if (!inv || !isRole(inv.role)) throw new MemberError('invalid_invite')
    // the same lock every member and invitation change takes first, so a revoke and this accept are serialized; the
    // guarded update below then sees the outcome of whichever ran first
    yield* lockWorkspace(t, inv.tenant_id)
    // a dead link (its inviter no longer has the authority, or it was used or revoked meanwhile) is dead to everyone:
    // the email is checked last, after the guarded update, so a wrong account cannot tell a dead link from a live one
    // (its refusal rolls the update back)
    const inviter = yield* roleOf(t, inv.tenant_id, inv.invited_by)
    if (!inviter || !mayManage(inviter, null, inv.role)) throw new MemberError('invalid_invite')
    const used = yield* t.run('UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [now, actor.actorId, inv.id, now])
    if (used.changes !== 1) throw new MemberError('invalid_invite')
    if (inv.email !== actor.email.trim().toLowerCase()) throw new MemberError('wrong_account')
    yield* t.run('INSERT INTO memberships (tenant_id, member_id, role, created_at, added_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, member_id) DO NOTHING',
      [inv.tenant_id, actor.actorId, inv.role, now, inv.invited_by])
    const role = yield* roleOf(t, inv.tenant_id, actor.actorId)
    return { tenantId: inv.tenant_id, role: role ?? inv.role }
  })
}

// Points a session at a workspace its account is a member of. getSessionUser re-checks the membership on every
// request; this only refuses a choice that is already wrong.
export async function switchWorkspace(db: Db, sessionHash: string, actorId: string, tenantId: string): Promise<void> {
  await db.tx(function* (t) {
    if (!(yield* roleOf(t, tenantId, actorId))) throw new MemberError('not_found')
    const r = yield* t.run('UPDATE sessions SET active_tenant_id = ? WHERE id = ? AND user_id = ?', [tenantId, sessionHash, actorId])
    if (r.changes !== 1) throw new MemberError('not_found')
  })
}
