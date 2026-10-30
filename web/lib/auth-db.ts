import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import path from 'path'
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'
import { BACKFILL_SQL, WORKSPACE_DDL, createPersonalWorkspace, resolveMembership } from './workspaces.ts'
import type { Role } from './workspaces.ts'
import { INVITATIONS_DDL } from './workspace-members.ts'
import { EMAIL_TOKENS_DDL } from './email-ownership.ts'
import { OUTBOX_DDL } from './system-mail.ts'
import { SEEN_EVERY_S, SESSION_COLUMNS, SESSION_INDEXES, newPublicId } from './sessions.ts'


let db: Database.Database | null = null

export function getAuthDb(): Database.Database {
  if (db) return db
  db = new Database(process.env.DB_PATH || path.join(process.cwd(), '..', '..', 'dazl-data', 'app.db'))
  db.pragma('journal_mode = WAL')
  migrateAuth(db)
  return db
}

export function migrateAuth(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      business_name TEXT,
      sells TEXT,
      website TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `)
  try { d.exec('ALTER TABLE users ADD COLUMN sells TEXT') } catch { /* exists */ }
  try { d.exec('ALTER TABLE users ADD COLUMN website TEXT') } catch { /* exists */ }
  try { d.exec('ALTER TABLE users ADD COLUMN buyer_profile TEXT') } catch { /* exists */ }
  // The workspace this session acts in (lib/workspaces.ts); NULL: the default one. PG: 0015_workspaces.sql.
  try { d.exec('ALTER TABLE sessions ADD COLUMN active_tenant_id TEXT') } catch { /* exists */ }
  // Session inventory and revocation (lib/sessions.ts). PG: 0021_session_inventory.sql.
  for (const c of SESSION_COLUMNS) { try { d.exec(c) } catch { /* exists */ } }
  const unnamed = d.prepare('SELECT id FROM sessions WHERE public_id IS NULL').all() as { id: string }[]
  const name = d.prepare('UPDATE sessions SET public_id = ? WHERE id = ?')
  d.transaction(() => { for (const r of unnamed) name.run(newPublicId(), r.id) })()
  d.exec('UPDATE sessions SET authed_at = coalesce(created_at, 0) WHERE authed_at IS NULL')
  d.exec(SESSION_INDEXES)
  // Email ownership and recovery (lib/email-ownership.ts); Google accounts are backfilled in migrateOauth.
  try { d.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER') } catch { /* exists */ }
  d.exec(EMAIL_TOKENS_DDL)
  d.exec(OUTBOX_DDL)
  d.exec(WORKSPACE_DDL)
  d.exec(INVITATIONS_DDL)

  d.transaction(() => { for (const s of BACKFILL_SQL) d.prepare(s).run() })()
}

// Sessions are stored as a SHA-256 digest; the raw token only lives in the cookie.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const SESSION_TTL_S = 60 * 60 * 24 * 30

const nowS = () => Math.floor(Date.now() / 1000)

// Final password sign-in commitment, serialized with recovery. Verification outside
// this lock may have used a password snapshot that recovery has since replaced.
export async function createPasswordSession(credentials: {id:string;password_hash:string;salt:string}, d?:Db, meta:{device?:string}={}):Promise<string|null>{
  return (d ?? await getDb()).tx(function*(t){
    yield* t.run('UPDATE users SET email=email WHERE id=?',[credentials.id])
    const live=yield* t.get<{password_hash:string;salt:string}>('SELECT password_hash,salt FROM users WHERE id=?',[credentials.id])
    if(!live || live.password_hash!==credentials.password_hash || live.salt!==credentials.salt)return null
    const token=randomBytes(32).toString('hex'),now=nowS()
    yield* t.run('INSERT INTO sessions (id,user_id,expires_at,public_id,last_seen_at,device,authed_at) VALUES(?,?,?,?,?,?,?)',[hashToken(token),credentials.id,now+SESSION_TTL_S,newPublicId(),now,(meta.device??'').slice(0,60)||null,now])
    return token
  })
}

// Sessions and sign-in run on the Db layer (docs/PLATFORM.md step 2). `d` defaults to the app's store. `device` is the
// coarse label from deviceLabel() (lib/sessions.ts), shown in the session list.
export async function createSession(userId: string, d?: Db, meta: { device?: string } = {}): Promise<string> {
  const token = randomBytes(32).toString('hex'), now = nowS()
  await (d ?? await getDb()).run('INSERT INTO sessions (id, user_id, expires_at, public_id, last_seen_at, device, authed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [hashToken(token), userId, now + SESSION_TTL_S, newPublicId(), now, (meta.device ?? '').slice(0, 60) || null, now])
  return token
}

// Password sign-in lookup. Unknown email -> undefined (the route still spends the same scrypt time).
export async function findPasswordUser(email: string, d?: Db): Promise<{ id: string; password_hash: string; salt: string } | undefined> {
  return (d ?? await getDb()).get('SELECT id, password_hash, salt FROM users WHERE email = ?', [email])
}

// 'exists' when the email is taken; the route must not reveal which. The account and its personal workspace are made
// together.
export async function createPasswordUser(u: { id: string; email: string; name: string; business_name: string; password_hash: string; salt: string }, d?: Db): Promise<'created' | 'exists'> {
  return (d ?? await getDb()).tx(function* (t) {
    const r = yield* t.run(
      'INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
      [u.id, u.email, u.name, u.business_name, u.password_hash, u.salt])
    if (r.changes !== 1) return 'exists' as const
    yield* createPersonalWorkspace(t, u.id, u.business_name)
    return 'created' as const
  })
}

// What the seller sells + their site, collected once on the home page. Used to aim ICP inference.
// Each profile read and write exists twice: sync on the raw handle (callers not yet on Db) and async on Db (SQLite or
// Postgres). Both run the same SQL and the same normalisation below, so they cannot drift apart.
const SELLER_SQL = 'SELECT sells, website FROM users WHERE id = ?'
const BUYER_SQL = 'SELECT buyer_profile FROM users WHERE id = ?'
const SET_BUYER_SQL = 'UPDATE users SET buyer_profile = ? WHERE id = ?'
const NAME_SQL = 'SELECT business_name FROM users WHERE id = ?'
const SET_NAME_SQL = 'UPDATE users SET business_name = ? WHERE id = ?'
const SET_SELLER_SQL = 'UPDATE users SET sells = ?, website = ? WHERE id = ?'
type SellerRow = { sells: string | null; website: string | null } | undefined
const seller = (r: SellerRow) => ({ sells: r?.sells ?? '', website: r?.website ?? '' })
const cleanName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 150)
const sellerLine = (p: { sells: string; website: string }) => [p.sells, p.website].filter(Boolean).join(' - ').slice(0, 300)

export function getSellerProfile(db: Database.Database, userId: string): { sells: string; website: string } {
  return seller(db.prepare(SELLER_SQL).get(userId) as SellerRow)
}
export async function readSellerProfile(db: Db, userId: string): Promise<{ sells: string; website: string }> {
  return seller(await db.get<NonNullable<SellerRow>>(SELLER_SQL, [userId]))
}

// Who the seller sells to, as reviewed in onboarding: a normalized Icp stored as JSON (validated by the caller with
// normalizeIcp). Read back through normalizeIcp too, so a stored row can never return fields the profile does not allow.
export function getBuyerProfile(db: Database.Database, userId: string): string | null {
  return (db.prepare(BUYER_SQL).get(userId) as { buyer_profile: string | null } | undefined)?.buyer_profile ?? null
}
export async function readBuyerProfile(db: Db, userId: string): Promise<string | null> {
  return (await db.get<{ buyer_profile: string | null }>(BUYER_SQL, [userId]))?.buyer_profile ?? null
}

export function setBuyerProfile(db: Database.Database, userId: string, json: string | null): void {
  db.prepare(SET_BUYER_SQL).run(json, userId)
}
export async function writeBuyerProfile(db: Db, userId: string, json: string | null): Promise<void> {
  await db.run(SET_BUYER_SQL, [json, userId])
}

export function getBusinessName(db: Database.Database, userId: string): string {
  return (db.prepare(NAME_SQL).get(userId) as { business_name: string | null } | undefined)?.business_name ?? ''
}
export async function readBusinessName(db: Db, userId: string): Promise<string> {
  return (await db.get<{ business_name: string | null }>(NAME_SQL, [userId]))?.business_name ?? ''
}

export function setBusinessName(db: Database.Database, userId: string, name: string): void {
  db.prepare(SET_NAME_SQL).run(cleanName(name), userId)
}
export async function writeBusinessName(db: Db, userId: string, name: string): Promise<void> {
  await db.run(SET_NAME_SQL, [cleanName(name), userId])
}

export function sellerProfile(db: Database.Database, userId: string): string {
  return sellerLine(getSellerProfile(db, userId))
}
export async function readSellerLine(db: Db, userId: string): Promise<string> {
  return sellerLine(await readSellerProfile(db, userId))
}

export function setSellerProfile(db: Database.Database, userId: string, sells: string, website: string): void {
  db.prepare(SET_SELLER_SQL).run(sells.slice(0, 150), website.slice(0, 200), userId)
}
export async function writeSellerProfile(db: Db, userId: string, sells: string, website: string): Promise<void> {
  await db.run(SET_SELLER_SQL, [sells.slice(0, 150), website.slice(0, 200), userId])
}

// The signed-in actor and the workspace they act in. actorId is the person (users.id); tenantId is the workspace every
// tenant-scoped read and write must use; role is their role there (check it with can(), lib/workspaces.ts). There is
// deliberately no plain `id`: a caller names which one it means. email is the actor's. business_name is the
// workspace's (its profile lives on the founder's users row, whose id is the workspace id). No membership in the
// session's workspace: not signed in (null). authedAt: when this session last proved who it is (lib/sessions.ts
// FRESH_AUTH_S; checked by stale() in lib/workspace-access.ts).
export type SessionUser = { email: string; business_name: string; actorId: string; tenantId: string; role: Role; authedAt: number }

export async function getSessionUser(token: string | undefined, d?: Db): Promise<SessionUser | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const db = d ?? await getDb()
  const id = hashToken(token)
  const now = nowS()
  const row = await db.get<{ id: string; email: string; business_name: string; active_tenant_id: string | null; last_seen_at: number | null; authed_at: number | null }>(
    `SELECT u.id, u.email, u.business_name, s.active_tenant_id, s.last_seen_at, coalesce(s.authed_at, s.created_at, 0) AS authed_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND s.revoked_at IS NULL`,
    [id, now])
  if (!row) return null
  if (row.last_seen_at === null || now - Number(row.last_seen_at) >= SEEN_EVERY_S) await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, id])

  const m = await resolveMembership(db, row, row.active_tenant_id)
  if (!m) {
    // The chosen workspace is gone for this member: this request fails, the next one uses their default workspace.
    if (row.active_tenant_id !== null) await db.run('UPDATE sessions SET active_tenant_id = NULL WHERE id = ? AND active_tenant_id = ?', [id, row.active_tenant_id])
    return null
  }
  const business_name = m.tenantId === row.id ? row.business_name : await readBusinessName(db, m.tenantId)
  return { email: row.email, business_name, actorId: row.id, tenantId: m.tenantId, role: m.role, authedAt: Number(row.authed_at ?? 0) }

}

// Whether the cookie is a live session (signed in, not expired, not revoked): authentication only, for the page gates (proxy.ts,
// the /app layout). Which workspace a request may act in is the API's decision (getSessionUser): a member removed from
// the workspace their session chose still gets the app shell, and its first API request meant for that workspace is
// refused there, never sent to the sign-in page as if signed out.
export async function hasLiveSession(token: string | undefined, d?: Db): Promise<boolean> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false
  return !!(await (d ?? await getDb()).get('SELECT 1 AS x FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND s.revoked_at IS NULL', [hashToken(token), nowS()]))
}

// Sign-out: the session is revoked (kept with who and when until the reaper's retention ends), not deleted.
export async function deleteSession(token: string | undefined, d?: Db): Promise<void> {
  if (!token) return
  await (d ?? await getDb()).run("UPDATE sessions SET revoked_at = ?, revoked_by = user_id, revoke_reason = 'signed_out' WHERE id = ? AND revoked_at IS NULL", [nowS(), hashToken(token)])
}

// Re-authentication on this session: it may change secrets, billing and members for another FRESH_AUTH_S.
export async function markSessionFresh(token: string, d?: Db): Promise<void> {
  await (d ?? await getDb()).run('UPDATE sessions SET authed_at = ? WHERE id = ? AND revoked_at IS NULL', [nowS(), hashToken(token)])
}

// The session a new sign-in replaces on this browser: revoked when it is this same account's, untouched otherwise.
export async function replacedSession(token: string | undefined, userId: string, d?: Db): Promise<void> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return
  await (d ?? await getDb()).run("UPDATE sessions SET revoked_at = ?, revoked_by = user_id, revoke_reason = 'signed_out' WHERE id = ? AND user_id = ? AND revoked_at IS NULL", [nowS(), hashToken(token), userId])
}
