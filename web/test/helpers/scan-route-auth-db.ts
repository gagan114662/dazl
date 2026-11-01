// The auth store IS the test database here (single in-memory sqlite): getAuthDb returns it, everything else is real.
import Database from 'better-sqlite3'
let db: Database.Database | null = null
export function setAuthDb(value: Database.Database) { db = value }
export function getAuthDb(): Database.Database { if (!db) throw new Error('test auth database unset'); return db }
export { sellerProfile, setSellerProfile } from '../../lib/auth-db.ts'
