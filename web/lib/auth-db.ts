import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import path from 'path'
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'

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

// 'exists' when the email is taken; the route must not reveal which.
export async function createPasswordUser(u: { id: string; email: string; name: string; business_name: string; password_hash: string; salt: string }, d?: Db): Promise<'created' | 'exists'> {
  const r = await (d ?? await getDb()).run(
    'INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
    [u.id, u.email, u.name, u.business_name, u.password_hash, u.salt])
  return r.changes === 1 ? 'created' : 'exists'
}

// What the seller sells + their site, collected once on the home page. Used to aim ICP inference.
export function getSellerProfile(db: Database.Database, userId: string): { sells: string; website: string } {
  const r = db.prepare('SELECT sells, website FROM users WHERE id = ?').get(userId) as { sells: string | null; website: string | null } | undefined
  return { sells: r?.sells ?? '', website: r?.website ?? '' }
}

export function getBusinessName(db: Database.Database, userId: string): string {
  const r = db.prepare('SELECT business_name FROM users WHERE id = ?').get(userId) as { business_name: string | null } | undefined
  return r?.business_name ?? ''
}

export function setBusinessName(db: Database.Database, userId: string, name: string): void {
  db.prepare('UPDATE users SET business_name = ? WHERE id = ?').run(name.replace(/\s+/g, ' ').trim().slice(0, 150), userId)
}

export function sellerProfile(db: Database.Database, userId: string): string {
  const p = getSellerProfile(db, userId)
  return [p.sells, p.website].filter(Boolean).join(' - ').slice(0, 300)
}

export function setSellerProfile(db: Database.Database, userId: string, sells: string, website: string): void {
  db.prepare('UPDATE users SET sells = ?, website = ? WHERE id = ?').run(sells.slice(0, 150), website.slice(0, 200), userId)
}

export async function getSessionUser(token: string | undefined, d?: Db): Promise<{ id: string; email: string; business_name: string } | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const row = await (d ?? await getDb()).get<{ id: string; email: string; business_name: string }>(
    `SELECT u.id, u.email, u.business_name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
    [hashToken(token), nowS()])
  return row ?? null
}

export async function deleteSession(token: string | undefined, d?: Db): Promise<void> {
  if (!token) return
  await (d ?? await getDb()).run('DELETE FROM sessions WHERE id = ?', [hashToken(token)])
}
