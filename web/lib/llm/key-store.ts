import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { decryptSecret, encryptSecret } from '../secrets.ts'
import type { Vendor } from './vendors.ts'

export function migrateKeys(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_llm_keys (
      tenant_id    TEXT NOT NULL,
      vendor       TEXT NOT NULL CHECK (vendor IN ('anthropic','openai')),
      ciphertext   TEXT NOT NULL,
      last4        TEXT NOT NULL,
      validated_at INTEGER NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, vendor)
    );
  `)
}

const ctx = (tenantId: string, vendor: Vendor) => `llm-key:${tenantId}:${vendor}`

// Save, status and delete exist sync (the raw handle: the runner, replies, SEO and tests) and async on Db (the settings
// route), with one SQL string each. validated_at comes from the caller's clock (epoch seconds, as strftime gave).
const SAVE_KEY_SQL = `INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, vendor) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = excluded.last4, validated_at = excluded.validated_at`
const keyArgs = (tenantId: string, vendor: Vendor, apiKey: string, master?: Buffer) =>
  [tenantId, vendor, encryptSecret(apiKey, ctx(tenantId, vendor), master), apiKey.slice(-4), Math.floor(Date.now() / 1000)]
export function saveKey(db: Database.Database, tenantId: string, vendor: Vendor, apiKey: string, master?: Buffer): void {
  db.prepare(SAVE_KEY_SQL).run(...keyArgs(tenantId, vendor, apiKey, master))
}
export async function writeKey(db: Db, tenantId: string, vendor: Vendor, apiKey: string, master?: Buffer): Promise<void> {
  await db.run(SAVE_KEY_SQL, keyArgs(tenantId, vendor, apiKey, master))
}

// Safe for the browser: never includes the key or ciphertext.
type KeyStatusRow = { vendor: Vendor; last4: string; validated_at: number }
const KEY_STATUS_SQL = 'SELECT vendor, last4, validated_at FROM tenant_llm_keys WHERE tenant_id = ? ORDER BY vendor' // the primary-key order SQLite gave
export function keyStatus(db: Database.Database, tenantId: string) {
  return db.prepare(KEY_STATUS_SQL).all(tenantId) as KeyStatusRow[]
}
export async function readKeyStatus(db: Db, tenantId: string): Promise<KeyStatusRow[]> {
  return (await db.all<KeyStatusRow>(KEY_STATUS_SQL, [tenantId])).map(r => ({ ...r, validated_at: Number(r.validated_at) }))
}

const HAS_KEY_SQL = 'SELECT 1 AS x FROM tenant_llm_keys WHERE tenant_id = ? LIMIT 1'
export function hasKey(db: Database.Database, tenantId: string): boolean {
  return db.prepare(HAS_KEY_SQL).get(tenantId) !== undefined
}
// hasKey on the Db layer (SQLite or Postgres).
export async function readHasKey(db: Db, tenantId: string): Promise<boolean> {
  return (await db.get(HAS_KEY_SQL, [tenantId])) !== undefined
}

const DELETE_KEY_SQL = 'DELETE FROM tenant_llm_keys WHERE tenant_id = ? AND vendor = ?'
export function deleteKey(db: Database.Database, tenantId: string, vendor: Vendor): boolean {
  return db.prepare(DELETE_KEY_SQL).run(tenantId, vendor).changes === 1
}
export async function removeKey(db: Db, tenantId: string, vendor: Vendor): Promise<boolean> {
  return (await db.run(DELETE_KEY_SQL, [tenantId, vendor])).changes === 1
}

// The tenant's most recently added vendor. Server-side only.
export function defaultVendor(db: Database.Database, tenantId: string): Vendor | null {
  const r = db.prepare('SELECT vendor FROM tenant_llm_keys WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(tenantId) as { vendor: Vendor } | undefined
  return r?.vendor ?? null
}

// Server-side only (the scan runner). Never return this from an API route.
export function getKey(db: Database.Database, tenantId: string, vendor: Vendor, master?: Buffer): string | null {
  const r = db.prepare('SELECT ciphertext FROM tenant_llm_keys WHERE tenant_id = ? AND vendor = ?').get(tenantId, vendor) as { ciphertext: string } | undefined
  return r ? decryptSecret(r.ciphertext, ctx(tenantId, vendor), master) : null
}

// getKey throws when the stored row cannot be decrypted (bad ciphertext from a manual
// insert, ciphertext copied from another tenant - the encryption context binds it to
// the tenant id, wrong master). On user-facing paths that throw escapes as a bare 500,
// so those callers use readKey instead: the real error is logged server-side and the
// caller gets a typed "unreadable" it can show honestly.
export function readKey(db: Database.Database, tenantId: string, vendor: Vendor, master?: Buffer): { key: string | null; unreadable: boolean } {
  try {
    return { key: getKey(db, tenantId, vendor, master), unreadable: false }
  } catch (e) {
    console.error(`stored ${vendor} key for tenant ${tenantId} could not be read:`, e instanceof Error ? e.message : e)
    return { key: null, unreadable: true }
  }
}
