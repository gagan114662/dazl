import type Database from 'better-sqlite3'
let db: Database.Database | null = null
export function setScanDb(value: Database.Database) { db = value }
export function getScanDb(): Database.Database { if (!db) throw new Error('test database unset'); return db }
export async function requireUser() { return { id: 'A', business_name: 'Acme' } }
