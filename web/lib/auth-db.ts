import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import path from 'path'

let db: Database.Database | null = null

export function getAuthDb(): Database.Database {
  if (db) return db
  db = new Database(process.env.DB_PATH || path.join(process.cwd(), '..', '..', 'dazl-data', 'app.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
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
    try { db.exec('ALTER TABLE users ADD COLUMN sells TEXT') } catch { /* exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN website TEXT') } catch { /* exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN buyer_profile TEXT') } catch { /* exists */ }
  return db
}

// Sessions are stored as a SHA-256 digest; the raw token only lives in the cookie.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const SESSION_TTL_S = 60 * 60 * 24 * 30

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex')
  getAuthDb()
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, Math.floor(Date.now() / 1000) + SESSION_TTL_S)
  return token
}

// What the seller sells + their site, collected once on the home page. Used to aim ICP inference.
export function getSellerProfile(db: Database.Database, userId: string): { sells: string; website: string } {
  const r = db.prepare('SELECT sells, website FROM users WHERE id = ?').get(userId) as { sells: string | null; website: string | null } | undefined
  return { sells: r?.sells ?? '', website: r?.website ?? '' }
}

// Who the seller sells to, as reviewed in onboarding: a normalized Icp stored as JSON (validated by the caller with
// normalizeIcp). Read back through normalizeIcp too, so a stored row can never return fields the profile does not allow.
export function getBuyerProfile(db: Database.Database, userId: string): string | null {
  const r = db.prepare('SELECT buyer_profile FROM users WHERE id = ?').get(userId) as { buyer_profile: string | null } | undefined
  return r?.buyer_profile ?? null
}

export function setBuyerProfile(db: Database.Database, userId: string, json: string | null): void {
  db.prepare('UPDATE users SET buyer_profile = ? WHERE id = ?').run(json, userId)
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

export function getSessionUser(token: string | undefined): { id: string; email: string; business_name: string } | null {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const row = getAuthDb()
    .prepare(
      `SELECT u.id, u.email, u.business_name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > unixepoch()`
    )
    .get(hashToken(token)) as { id: string; email: string; business_name: string } | undefined
  return row ?? null
}

export function deleteSession(token: string | undefined): void {
  if (!token) return
  getAuthDb().prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token))
}
