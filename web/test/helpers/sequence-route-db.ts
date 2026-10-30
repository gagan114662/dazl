import type Database from 'better-sqlite3'
let db: Database.Database | null = null
export function setScanDb(value: Database.Database) { db = value }
export function getScanDb(): Database.Database { if (!db) throw new Error('test database unset'); return db }
export async function requireUser() { return { tenantId: 'A', actorId: 'A', role: 'owner' as const, email: 'a@example.test', business_name: 'Acme', authedAt: Math.floor(Date.now() / 1000) } }

