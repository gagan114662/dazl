import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import path from 'path'
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'
import { BACKFILL_SQL, WORKSPACE_DDL, createPersonalWorkspace, resolveMembership } from './workspaces.ts'
import { AUDIT_DDL } from './audit.ts'
import type { Role } from './workspaces.ts'

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
  // Durable audit trail (lib/audit.ts). PG: 0019_audit_events.sql.
  d.exec(AUDIT_DDL)
  d.exec(WORKSPACE_DDL)
  d.transaction(() => { for (const s of BACKFILL_SQL) d.prepare(s).run() })()
}

// Sessions are stored as a SHA-256 digest; the raw token only lives in the cookie.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const SESSION_TTL_S = 60 * 60 * 24 * 30

const nowS = () => Math.floor(Date.now() / 1000)

// Sessions and sign-in run on the Db layer (docs/PLATFORM.md step 2). `d` defaults to the app's store.
export async function createSession(userId: string, d?: Db): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await (d ?? await getDb()).run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), userId, nowS() + SESSION_TTL_S])
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
// session's workspace: not signed in (null).
export type SessionUser = { email: string; business_name: string; actorId: string; tenantId: string; role: Role }
export async function getSessionUser(token: string | undefined, d?: Db): Promise<SessionUser | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const db = d ?? await getDb()
  const id = hashToken(token)
  const row = await db.get<{ id: string; email: string; business_name: string; active_tenant_id: string | null }>(
    `SELECT u.id, u.email, u.business_name, s.active_tenant_id FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
    [id, nowS()])
  if (!row) return null
  const m = await resolveMembership(db, row, row.active_tenant_id)
  if (!m) {
    // The chosen workspace is gone for this member: this request fails, the next one uses their default workspace.
    if (row.active_tenant_id !== null) await db.run('UPDATE sessions SET active_tenant_id = NULL WHERE id = ? AND active_tenant_id = ?', [id, row.active_tenant_id])
    return null
  }
  const business_name = m.tenantId === row.id ? row.business_name : await readBusinessName(db, m.tenantId)
  return { email: row.email, business_name, actorId: row.id, tenantId: m.tenantId, role: m.role }
}

export async function deleteSession(token: string | undefined, d?: Db): Promise<void> {
  if (!token) return
  await (d ?? await getDb()).run('DELETE FROM sessions WHERE id = ?', [hashToken(token)])
}
