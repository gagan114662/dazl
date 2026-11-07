// Only the physical SQLite opener is replaced. Production scan/service (including requireUser) remains real.
import type Database from 'better-sqlite3'
export { migrateAuth } from '../../lib/db/sqlite-store.ts'
let raw: Database.Database | undefined
let opens = 0
export function setDomain(value: Database.Database) { raw = value; opens = 0 }
export function domainOpens() { return opens }
export function getAuthDb(): Database.Database { opens++; if (!raw) throw new Error('domain fixture unset'); return raw }
