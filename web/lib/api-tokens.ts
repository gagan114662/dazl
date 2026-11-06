// Scoped, revocable per-workspace API tokens for the external discovery API (#392, app/api/mcp).
//
// A token is a random secret shown ONCE at creation (`dzl_` + 43 base64url chars, 256 bits); the store keeps only its
// SHA-256 (token_hash) and a separate public id, the only handle the UI, the API and the audit trail ever show. Nothing
// here logs, returns or audits the secret or its hash.
//
// Authority is decided on every request, from the store, never from the request body or from any content a tool returns:
//   - the token row: not revoked, not expired, its workspace not tombstoned (deletion also erases the rows: they are in
//     CREDENTIAL_TABLES, lib/tenant/lifecycle.ts);
//   - the creator's CURRENT membership role in that workspace (lib/workspaces.ts): a member who is removed or demoted
//     takes the token's authority with them at once;
//   - the token's scopes, intersected with that role: 'read' needs a role that may read, 'scan' one that may operate.
// There is no send scope: discovery permission never carries sending authority, and no tool can draft, send or push.
//
// Spend: a 'scan' token carries its own reservation - at most scans_per_day scans per rolling day (counted atomically in
// the shared rate_limits store, fails closed) and max_usd_per_scan as the run budget every API scan is forced to carry
// (lib/scan/run-budget.ts max_usd, with paid fallback and credit enrichment off). Every app gate still applies on top
// (lib/scan/start-scan.ts: one scan at a time, plan quota, estimate / owner spend pools, offer conflicts).
// Idempotency: an API scan is claimed by (token, idempotency key) BEFORE anything is started, so a retry of the same
// key never starts or pays for a second scan; it gets the first one's job id back.
//
// OFF by default: the API answers 404 and no token can be created unless DAZL_API_TOKENS=1 (the owner decides; listing
// and revoking existing tokens always work).
import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db } from './db/client.ts'
import { can, isRole } from './workspaces.ts'
import type { Role } from './workspaces.ts'

export function migrateApiTokens(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      scans_per_day INTEGER NOT NULL DEFAULT 0,
      max_usd_per_scan REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS api_tokens_tenant ON api_tokens (tenant_id);
    CREATE TABLE IF NOT EXISTS api_token_scans (
      tenant_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      scan_job_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (token_id, idem_key)
    );
    CREATE INDEX IF NOT EXISTS api_token_scans_tenant ON api_token_scans (tenant_id);
  `)
}

export const SCOPES = ['read', 'scan'] as const
export type Scope = typeof SCOPES[number]
// What each scope needs from the creator's current role in the workspace.
export const SCOPE_ACTION = { read: 'read', scan: 'operate' } as const satisfies Record<Scope, 'read' | 'operate'>
export const MAX_ACTIVE_TOKENS = 10
export const MAX_SCANS_PER_DAY = 20
export const DEFAULT_SCANS_PER_DAY = 3
export const MAX_USD_PER_SCAN = 25
export const DEFAULT_USD_PER_SCAN = 2
export const MAX_TTL_DAYS = 365
export const DEFAULT_TTL_DAYS = 90
const USED_EVERY_S = 5 * 60
const nowS = () => Math.floor(Date.now() / 1000)

export const apiEnabled = (env: Record<string, string | undefined> = process.env) => env.DAZL_API_TOKENS === '1'
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex')
export const isTokenId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v)
const SECRET = /^dzl_[A-Za-z0-9_-]{43}$/

// The secret from an Authorization header, or null for anything that is not exactly "Bearer dzl_<43>".
export function bearerSecret(header: string | null): string | null {
  const m = /^Bearer ([^\s]+)$/.exec((header ?? '').trim())
  return m && SECRET.test(m[1]) ? m[1] : null
}

export type TokenSpec = { label: string; scopes: Scope[]; scansPerDay: number; maxUsdPerScan: number; ttlDays: number }
// Strict: an unknown scope, an out-of-range limit or a limit on a read-only token is refused, never clamped or ignored.
export function parseTokenSpec(body: unknown): { ok: true; spec: TokenSpec } | { ok: false; error: string } {
  const o = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : ''
  if (label.length < 1) return { ok: false, error: 'label is required' }
  if (!Array.isArray(o.scopes) || o.scopes.length === 0 || !o.scopes.every(s => (SCOPES as readonly unknown[]).includes(s))) return { ok: false, error: `scopes must be a non-empty list of ${SCOPES.join(', ')}` }
  const scopes = SCOPES.filter(s => (o.scopes as unknown[]).includes(s))
  if (!scopes.includes('read')) return { ok: false, error: "every token needs the 'read' scope (a scan token must be able to poll what it started)" }
  const scan = scopes.includes('scan')
  const int = (v: unknown, d: number, lo: number, hi: number) => v === undefined ? d : typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : NaN
  const num = (v: unknown, d: number, lo: number, hi: number) => v === undefined ? d : typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : NaN
  if (!scan && (o.scans_per_day !== undefined || o.max_usd_per_scan !== undefined)) return { ok: false, error: "scans_per_day and max_usd_per_scan apply only to a token with the 'scan' scope" }
  const scansPerDay = scan ? int(o.scans_per_day, DEFAULT_SCANS_PER_DAY, 1, MAX_SCANS_PER_DAY) : 0
  if (Number.isNaN(scansPerDay)) return { ok: false, error: `scans_per_day must be a whole number from 1 to ${MAX_SCANS_PER_DAY}` }
  const maxUsdPerScan = scan ? num(o.max_usd_per_scan, DEFAULT_USD_PER_SCAN, 0.01, MAX_USD_PER_SCAN) : 0
  if (Number.isNaN(maxUsdPerScan)) return { ok: false, error: `max_usd_per_scan must be a number from 0.01 to ${MAX_USD_PER_SCAN}` }
  const ttlDays = int(o.expires_in_days, DEFAULT_TTL_DAYS, 1, MAX_TTL_DAYS)
  if (Number.isNaN(ttlDays)) return { ok: false, error: `expires_in_days must be a whole number from 1 to ${MAX_TTL_DAYS}` }
  return { ok: true, spec: { label, scopes, scansPerDay, maxUsdPerScan, ttlDays } }
}

export type TokenView = { id: string; label: string; scopes: Scope[]; scans_per_day: number; max_usd_per_scan: number; created_by: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }
type Row = { id: string; label: string; scopes: string; scans_per_day: number; max_usd_per_scan: number; created_by: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }
const view = (r: Row): TokenView => ({ id: r.id, label: r.label, scopes: r.scopes.split(' ').filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)), scans_per_day: Number(r.scans_per_day), max_usd_per_scan: Number(r.max_usd_per_scan), created_by: r.created_by, created_at: Number(r.created_at), expires_at: Number(r.expires_at), last_used_at: r.last_used_at === null ? null : Number(r.last_used_at), revoked_at: r.revoked_at === null ? null : Number(r.revoked_at) })

// The new token; `secret` is returned only here and never stored. null: the workspace already has MAX_ACTIVE_TOKENS
// working tokens (revoke one first).
export async function createToken(db: Db, tenantId: string, actorId: string, spec: TokenSpec, now = nowS()): Promise<(TokenView & { secret: string }) | null> {
  const id = randomBytes(12).toString('hex')
  const secret = `dzl_${randomBytes(32).toString('base64url')}`
  const made = await db.tx(function* (t) {
    const n = yield* t.get<{ n: number }>('SELECT count(*) AS n FROM api_tokens WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ?', [tenantId, now])
    if (Number(n?.n ?? 0) >= MAX_ACTIVE_TOKENS) return false
    yield* t.run(`INSERT INTO api_tokens (id, tenant_id, created_by, label, token_hash, scopes, scans_per_day, max_usd_per_scan, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, tenantId, actorId, spec.label, hashSecret(secret), spec.scopes.join(' '), spec.scansPerDay, spec.maxUsdPerScan, now, now + spec.ttlDays * 86400])
    return true
  })
  if (!made) return null
  return { ...view({ id, label: spec.label, scopes: spec.scopes.join(' '), scans_per_day: spec.scansPerDay, max_usd_per_scan: spec.maxUsdPerScan, created_by: actorId, created_at: now, expires_at: now + spec.ttlDays * 86400, last_used_at: null, revoked_at: null }), secret }
}

// The workspace's tokens, newest first: revoked ones included (who revoked, when), never a secret or a hash.
export async function listTokens(db: Db, tenantId: string): Promise<TokenView[]> {
  const rows = await db.all<Row>('SELECT id, label, scopes, scans_per_day, max_usd_per_scan, created_by, created_at, expires_at, last_used_at, revoked_at FROM api_tokens WHERE tenant_id = ? ORDER BY created_at DESC, id', [tenantId])
  return rows.map(view)
}

// Revokes one of the workspace's tokens by its public id. false: no such working token in this workspace (the same
// answer for another workspace's id). Effective on the next request on every instance: the check is this row.
export async function revokeToken(db: Db, tenantId: string, id: string, by: string, now = nowS()): Promise<boolean> {
  if (!isTokenId(id)) return false
  const r = await db.run('UPDATE api_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL', [now, by, id, tenantId])
  return r.changes === 1
}

export type ApiPrincipal = { tokenId: string; tenantId: string; actorId: string; role: Role; scopes: Scope[]; scansPerDay: number; maxUsdPerScan: number }

// The caller behind a bearer secret, with the scopes it may use NOW (granted scopes the creator's current role still
// allows). null: unknown, revoked or expired token, tombstoned workspace, or the creator is no longer a member.
export async function authenticate(db: Db, secret: string, now = nowS()): Promise<ApiPrincipal | null> {
  const r = await db.get<{ id: string; tenant_id: string; created_by: string; scopes: string; scans_per_day: number; max_usd_per_scan: number; last_used_at: number | null; role: string }>(
    `SELECT t.id, t.tenant_id, t.created_by, t.scopes, t.scans_per_day, t.max_usd_per_scan, t.last_used_at, m.role
     FROM api_tokens t JOIN memberships m ON m.tenant_id = t.tenant_id AND m.member_id = t.created_by
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM tenant_tombstones x WHERE x.deleted_tenant = t.tenant_id)`, [hashSecret(secret), now])
  if (!r || !isRole(r.role)) return null
  const role: Role = r.role
  const scopes = view({ ...r, label: '', created_at: 0, expires_at: 0, revoked_at: null } as Row).scopes.filter(s => can(role, SCOPE_ACTION[s]))
  if (!scopes.length) return null
  if (r.last_used_at === null || now - Number(r.last_used_at) >= USED_EVERY_S) await db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [now, r.id])
  return { tokenId: r.id, tenantId: r.tenant_id, actorId: r.created_by, role, scopes, scansPerDay: Number(r.scans_per_day), maxUsdPerScan: Number(r.max_usd_per_scan) }
}

// Idempotent API scan starts. claim(): the first call for (token, key) wins and returns { claimed: true }; any later call
// returns the stored claim: the same request gets its scan back (job_id, or null while the first start is in flight or
// if it died mid-way - never a second start), a different request under the same key is a conflict.
export const isIdemKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{8,80}$/.test(v)
export const requestHash = (req: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(req)).digest('hex')
export type Claim = { claimed: true } | { claimed: false; sameRequest: boolean; jobId: string | null }
export async function claimScan(db: Db, p: ApiPrincipal, key: string, reqHash: string, now = nowS()): Promise<Claim> {
  return db.tx(function* (t) {
    const ins = yield* t.run('INSERT INTO api_token_scans (tenant_id, token_id, idem_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (token_id, idem_key) DO NOTHING',
      [p.tenantId, p.tokenId, key, reqHash, now])
    if (ins.changes === 1) return { claimed: true } as const
    const r = yield* t.get<{ request_hash: string; scan_job_id: string | null }>('SELECT request_hash, scan_job_id FROM api_token_scans WHERE token_id = ? AND idem_key = ? AND tenant_id = ?', [p.tokenId, key, p.tenantId])
    return { claimed: false, sameRequest: r?.request_hash === reqHash, jobId: r?.scan_job_id ?? null } as const
  })
}
// The claimed start created this job.
export async function settleClaim(db: Db, p: ApiPrincipal, key: string, jobId: string): Promise<void> {
  await db.run('UPDATE api_token_scans SET scan_job_id = ? WHERE token_id = ? AND idem_key = ? AND tenant_id = ? AND scan_job_id IS NULL', [jobId, p.tokenId, key, p.tenantId])
}
// The claimed start was refused before anything was created: the key is free again, so a retry can try once more.
export async function releaseClaim(db: Db, p: ApiPrincipal, key: string): Promise<void> {
  await db.run('DELETE FROM api_token_scans WHERE token_id = ? AND idem_key = ? AND tenant_id = ? AND scan_job_id IS NULL', [p.tokenId, key, p.tenantId])
}
