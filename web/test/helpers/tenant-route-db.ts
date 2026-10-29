import type Database from 'better-sqlite3'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
import type { SessionUser } from '../../lib/auth-db.ts'
import type { Role } from '../../lib/workspaces.ts'
let db: Database.Database | null = null
let user: SessionUser | null = null
// Routes on the Db layer (getDb) and routes still on the raw handle (getScanDb) see the same fixture store, as they do
// in the app, where both wrap one SQLite connection.
export function setScanDb(value: Database.Database) { db = value; setDb(sqliteDb(value)) }
// `id` is the workspace (tenant); the actor defaults to the workspace's founder, the role to owner, as for every
// account until it is invited into another workspace.
export function setUser(u: { id: string; business_name: string; role?: Role; actorId?: string; email?: string; authedAt?: number } | null) {
  user = u && { tenantId: u.id, actorId: u.actorId ?? u.id, role: u.role ?? 'owner', business_name: u.business_name, email: u.email ?? `${u.id}@example.test`, authedAt: u.authedAt ?? Math.floor(Date.now() / 1000) }
}
export function getScanDb(): Database.Database { if (!db) throw new Error('test database unset'); return db }
export async function requireUser() { return user }
