import type Database from 'better-sqlite3'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
let db: Database.Database | null = null
// Routes on the Db layer (getDb) see the same fixture store as routes on the raw handle, as in the app.
export function setScanDb(value: Database.Database) { db = value; setDb(sqliteDb(value)) }
export function getScanDb(): Database.Database { if (!db) throw new Error('test database unset'); return db }
export async function requireUser() { return { tenantId: 'A', actorId: 'A', role: 'owner' as const, email: 'a@example.test', business_name: 'Acme' } }
