import type Database from 'better-sqlite3'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
let db: Database.Database | null = null
let user: { id: string; business_name: string } | null = null
// Routes on the Db layer (getDb) and routes still on the raw handle (getScanDb) see the same fixture store, as they do
// in the app, where both wrap one SQLite connection.
export function setScanDb(value: Database.Database) { db = value; setDb(sqliteDb(value)) }
export function setUser(u: { id: string; business_name: string } | null) { user = u }
export function getScanDb(): Database.Database { if (!db) throw new Error('test database unset'); return db }
export async function requireUser() { return user }
