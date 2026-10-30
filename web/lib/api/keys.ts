// Scoped per-workspace API keys for the external discovery API (#392). A key is shown once at creation; the store keeps
// only its SHA-256, so a leaked database row cannot be replayed. Every request looks the key up again: a revoked key,
// or a key whose creator has left the workspace or lost the role, fails on its very next request on any instance.
//
// Scopes are discovery only. There is no scope that sends, drafts, exports or changes CRM data, and an unknown scope
// is refused when the key is made, so no key can ever carry sending authority, implicitly or otherwise.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { can, isRole, type Action } from '../workspaces.ts'

export const SCOPES = ['discovery:read', 'discovery:start'] as const
export type Scope = typeof SCOPES[number]
// the workspace role the key's creator must still hold for each scope (lib/workspaces.ts ACTIONS)
const ROLE_FOR: Record<Scope, Action> = { 'discovery:read': 'read', 'discovery:start': 'operate' }

export const API_KEYS_DDL = [
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY CHECK (length(id) = 16),
    tenant_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) <= 80),
    key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
    scopes TEXT NOT NULL CHECK (length(scopes) <= 200),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS api_keys_tenant ON api_keys (tenant_id)',
  // Idempotent discovery starts: one row per (workspace, Idempotency-Key). A retry with the same key and body gets the
  // same job and never queues (or pays for) a second scan.
  `CREATE TABLE IF NOT EXISTS api_idempotency (
    tenant_id TEXT NOT NULL,
    idem_key TEXT NOT NULL CHECK (length(idem_key) <= 128),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    job_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, idem_key)
  )`,
]
export function migrateApiKeys(db: { exec(sql: string): unknown }): void {
  for (const s of API_KEYS_DDL) db.exec(s)
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const nowS = () => Math.floor(Date.now() / 1000)
const KEY_RE = /^dzk_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/

export function parseScopes(v: unknown): Scope[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out = new Set<Scope>()
  for (const s of v) { if (!(SCOPES as readonly string[]).includes(s)) return null; out.add(s as Scope) }
  return [...out].sort()
}

// The plaintext key is returned here and nowhere else.
export async function createApiKey(db: Db, tenantId: string, createdBy: string, name: string, scopes: unknown): Promise<{ id: string; key: string; scopes: Scope[] } | { error: 'invalid_scopes' | 'invalid_name' }> {
  const sc = parseScopes(scopes)
  if (!sc) return { error: 'invalid_scopes' }
  const nm = name.trim()
  if (!nm || nm.length > 80) return { error: 'invalid_name' }
  const id = randomBytes(8).toString('hex')
  const key = `dzk_${id}_${randomBytes(32).toString('base64url')}`
  await db.run('INSERT INTO api_keys (id, tenant_id, created_by, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, tenantId, createdBy, nm, sha(key), JSON.stringify(sc), nowS()])
  return { id, key, scopes: sc }
}

// Revokes only this workspace's key; another workspace's id changes nothing.
export async function revokeApiKey(db: Db, tenantId: string, id: string): Promise<boolean> {
  return (await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL', [nowS(), id, tenantId])).changes === 1
}

export type KeyAuth = { ok: true; tenantId: string; actorId: string; keyId: string; scopes: Scope[] } | { ok: false; status: 401 | 403; error: string }

// Authorization: Bearer dzk_<id>_<secret>. The tenant comes from the key row only, never from the request.
export async function authenticateKey(db: Db, authorization: string | null, need: Scope): Promise<KeyAuth> {
  const m = KEY_RE.exec((authorization ?? '').replace(/^Bearer\s+/i, '').trim())
  if (!m) return { ok: false, status: 401, error: 'invalid_key' }
  const row = await db.get<{ id: string; tenant_id: string; created_by: string; key_hash: string; scopes: string; revoked_at: number | null }>(
    'SELECT id, tenant_id, created_by, key_hash, scopes, revoked_at FROM api_keys WHERE id = ?', [m[1]])
  const given = Buffer.from(sha(m[0]), 'hex')
  if (!row || !timingSafeEqual(given, Buffer.from(row.key_hash, 'hex')) || row.revoked_at !== null) return { ok: false, status: 401, error: 'invalid_key' }
  const scopes = parseScopes(JSON.parse(row.scopes)) ?? []
  if (!scopes.includes(need)) return { ok: false, status: 403, error: 'missing_scope' }
  // the key acts for its creator: they must still be a member of the workspace with a role allowing this scope
  const r = (await db.get<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = ? AND member_id = ?', [row.tenant_id, row.created_by]))?.role
  if (!isRole(r)) return { ok: false, status: 401, error: 'invalid_key' }
  if (!can(r, ROLE_FOR[need])) return { ok: false, status: 403, error: 'forbidden' }
  await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowS(), row.id])
  return { ok: true, tenantId: row.tenant_id, actorId: row.created_by, keyId: row.id, scopes }
}

// Reserve an Idempotency-Key for this workspace before admitting the scan. 'new': the caller admits and then calls
// settleIdempotency; 'replay': the same request already queued this job; 'in_progress' / 'mismatch': refuse.
export type Idem = { kind: 'new' } | { kind: 'replay'; jobId: string } | { kind: 'in_progress' } | { kind: 'mismatch' }
export const requestHash = (body: unknown) => sha(JSON.stringify(body ?? null))
export async function reserveIdempotency(db: Db, tenantId: string, key: string, hash: string): Promise<Idem> {
  const ins = await db.run('INSERT INTO api_idempotency (tenant_id, idem_key, request_hash, job_id, created_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT (tenant_id, idem_key) DO NOTHING',
    [tenantId, key, hash, nowS()])
  if (ins.changes === 1) return { kind: 'new' }
  const row = await db.get<{ request_hash: string; job_id: string | null }>('SELECT request_hash, job_id FROM api_idempotency WHERE tenant_id = ? AND idem_key = ?', [tenantId, key])
  if (!row || row.request_hash !== hash) return { kind: 'mismatch' }
  return row.job_id ? { kind: 'replay', jobId: row.job_id } : { kind: 'in_progress' }
}
// A queued job is recorded against the key; a refused admission frees the key so a corrected retry can run.
export async function settleIdempotency(db: Db, tenantId: string, key: string, jobId: string | null): Promise<void> {
  if (jobId) await db.run('UPDATE api_idempotency SET job_id = ? WHERE tenant_id = ? AND idem_key = ?', [jobId, tenantId, key])
  else await db.run('DELETE FROM api_idempotency WHERE tenant_id = ? AND idem_key = ? AND job_id IS NULL', [tenantId, key])
}
