import type Database from 'better-sqlite3'
let db: Database.Database | null = null
let user: { id: string; business_name: string } | null = null
export function setScanDb(value: Database.Database) { db = value }
export function setUser(u: { id: string; business_name: string } | null) { user = u }
export function getScanDb(): Database.Database { if (!db) throw new Error('test database unset'); return db }
export async function requireUser() { return user }
