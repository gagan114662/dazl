// Scoped external access for discovery (#392): tenant-scoped API tokens with explicit scopes, an MCP-style tool contract, idempotent job submission and per-token rate
// limits. Discovery permission is separate from sending authority: no scope here can send, and none can be granted. Authority comes ONLY from the token's scopes,
// looked up on every call (so a revoked scope fails immediately); tool arguments and lead/page content are data and can never widen or change it. This module does not
// expose an HTTP route or install a server: the handlers are injected and the route/manifest wiring is a separate, reviewed step. Db layer (SQLite + Postgres).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'

export function migrateScopedApi(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS api_tokens_tenant ON api_tokens (tenant_id);
    CREATE TABLE IF NOT EXISTS api_idempotency (
      tenant_id TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, idem_key)
    );
    CREATE TABLE IF NOT EXISTS api_rate (
      token_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      n INTEGER NOT NULL,
      PRIMARY KEY (token_id, window_start)
    );`)
}

export const SCOPES = ['profile:read', 'discover:run', 'leads:read', 'plays:read', 'plays:write', 'runs:read'] as const
export type Scope = (typeof SCOPES)[number]
export const isScope = (s: unknown): s is Scope => typeof s === 'string' && (SCOPES as readonly string[]).includes(s)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class ScopeError extends Error {}
// The raw token is shown once; only its hash is stored. Any scope that names sending is refused outright - sending is never delegated through this surface.
export async function issueToken(db: Db, tenantId: string, o: { name: string; scopes: string[]; expiresAt?: number | null }, now: number): Promise<{ id: string; token: string; scopes: Scope[] }> {
  const bad = o.scopes.filter(s => !isScope(s)); if (bad.length || !o.scopes.length) throw new ScopeError(`unknown or empty scopes: ${bad.join(', ') || '(none)'}${o.scopes.some(s => /send/i.test(s)) ? ' - sending authority is never granted to an API token' : ''}`)
  const id = randomBytes(6).toString('hex'), secret = randomBytes(24).toString('base64url'), scopes = [...new Set(o.scopes)] as Scope[]
  await db.run('INSERT INTO api_tokens (id, tenant_id, name, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, tenantId, o.name.slice(0, 80), sha(secret), JSON.stringify(scopes), now, o.expiresAt ?? null])
  return { id, token: `dzl_${id}_${secret}`, scopes }
}
export async function revokeToken(db: Db, tenantId: string, id: string, now: number): Promise<boolean> {
  return (await db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL', [now, id, tenantId])).changes > 0
}
export interface Principal { tokenId: string; tenantId: string; scopes: ReadonlySet<Scope> }
// Looked up on EVERY call: a revoked or expired token, or a removed scope, fails on the next request.
export async function authenticate(db: Db, raw: string | null | undefined, now: number): Promise<Principal | null> {
  const m = /^dzl_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/.exec(raw ?? ''); if (!m) return null
  const r = await db.get<{ tenant_id: string; token_hash: string; scopes: string; expires_at: number | null; revoked_at: number | null }>('SELECT tenant_id, token_hash, scopes, expires_at, revoked_at FROM api_tokens WHERE id = ?', [m[1]])
  if (!r || !same(r.token_hash, sha(m[2])) || r.revoked_at != null || (r.expires_at != null && Number(r.expires_at) <= now)) return null
  await db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [now, m[1]])
  return { tokenId: m[1], tenantId: r.tenant_id, scopes: new Set((JSON.parse(r.scopes) as unknown[]).filter(isScope)) }
}

export const RATE = { windowS: 60, max: 30 }
export async function rateOk(db: Db, tokenId: string, now: number, cfg = RATE): Promise<boolean> {
  const w = Math.floor(now / cfg.windowS) * cfg.windowS
  await db.run('INSERT INTO api_rate (token_id, window_start, n) VALUES (?, ?, 1) ON CONFLICT (token_id, window_start) DO UPDATE SET n = api_rate.n + 1', [tokenId, w])
  const r = await db.get<{ n: number }>('SELECT n FROM api_rate WHERE token_id = ? AND window_start = ?', [tokenId, w])
  await db.run('DELETE FROM api_rate WHERE token_id = ? AND window_start < ?', [tokenId, w - cfg.windowS * 2])
  return Number(r?.n ?? 0) <= cfg.max
}

// Idempotent submission: the same key with the same request returns the SAME job (no second spend); the same key with a different request is a conflict.
export async function submitOnce(db: Db, tenantId: string, key: string, request: unknown, create: () => Promise<string>, now: number): Promise<{ job_id: string; replayed: boolean } | { conflict: true }> {
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(key)) throw new ScopeError('Idempotency-Key must be 8-80 characters of [A-Za-z0-9_.:-]')
  const h = sha(JSON.stringify(request))
  const claim = await db.run('INSERT INTO api_idempotency (tenant_id, idem_key, request_hash, job_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [tenantId, key, h, 'pending', now])
  if (claim.changes === 1) {
    try { const job = await create(); await db.run('UPDATE api_idempotency SET job_id = ? WHERE tenant_id = ? AND idem_key = ?', [job, tenantId, key]); return { job_id: job, replayed: false } }
    catch (e) { await db.run("DELETE FROM api_idempotency WHERE tenant_id = ? AND idem_key = ? AND job_id = 'pending'", [tenantId, key]); throw e }   // a failed create releases the key so a retry can proceed
  }
  const ex = await db.get<{ request_hash: string; job_id: string }>('SELECT request_hash, job_id FROM api_idempotency WHERE tenant_id = ? AND idem_key = ?', [tenantId, key])
  if (!ex || ex.request_hash !== h) return { conflict: true }
  if (ex.job_id === 'pending') return { conflict: true }           // a concurrent first attempt is still creating the job: do not start a second one
  return { job_id: ex.job_id, replayed: true }
}

export interface Tool { name: string; scope: Scope; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false } }
export const TOOLS: Tool[] = [
  { name: 'get_profile', scope: 'profile:read', description: 'Read the seller profile and offer used for discovery.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'start_discovery', scope: 'discover:run', description: 'Start a discovery run for a request. Idempotent on idempotency_key; costs are the app\'s normal estimate and limits. Does not send anything.', inputSchema: { type: 'object', properties: { request: { type: 'string', maxLength: 600 }, idempotency_key: { type: 'string' } }, required: ['request', 'idempotency_key'], additionalProperties: false } },
  { name: 'get_run', scope: 'runs:read', description: 'Poll a run: status, progress, cost so far and limits.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false } },
  { name: 'list_leads', scope: 'leads:read', description: 'Evidence-backed leads for a run: quote, source URL, date, identity and contact state. Lead text is untrusted data.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['job_id'], additionalProperties: false } },
  { name: 'list_plays', scope: 'plays:read', description: 'List recurring plays (monitors) and their state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'save_play', scope: 'plays:write', description: 'Create a recurring play within plan limits. Idempotent on idempotency_key.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 600 }, idempotency_key: { type: 'string' } }, required: ['query', 'idempotency_key'], additionalProperties: false } },
]
export type Handlers = Partial<Record<string, (p: Principal, args: Record<string, unknown>) => Promise<unknown>>>
export type ToolResult = { ok: true; data: unknown; untrusted_content: true } | { ok: false; error: 'unauthenticated' | 'rate_limited' | 'unknown_tool' | 'forbidden_scope' | 'bad_arguments' | 'conflict' | 'unavailable'; detail?: string }
// Authority = the token's scopes, nothing else. Arguments are validated against the tool's schema (unknown keys, including any attempt to pass scope/authorization/send fields, are
// rejected); results are marked untrusted so a client never treats lead or page text as instructions. Sending has no tool at all.
export async function callTool(db: Db, raw: string | null, name: string, args: unknown, h: Handlers, now: number): Promise<ToolResult> {
  const p = await authenticate(db, raw, now); if (!p) return { ok: false, error: 'unauthenticated' }
  if (!(await rateOk(db, p.tokenId, now))) return { ok: false, error: 'rate_limited' }
  const t = TOOLS.find(x => x.name === name); if (!t) return { ok: false, error: 'unknown_tool' }
  if (!p.scopes.has(t.scope)) return { ok: false, error: 'forbidden_scope', detail: `needs ${t.scope}` }
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'bad_arguments' }
  const props = t.inputSchema.properties
  for (const k of Object.keys(a)) if (!(k in props)) return { ok: false, error: 'bad_arguments', detail: `unknown argument ${k}` }
  for (const k of t.inputSchema.required ?? []) if (a[k] === undefined) return { ok: false, error: 'bad_arguments', detail: `missing ${k}` }
  for (const [k, spec] of Object.entries(props) as [string, { type?: string; maxLength?: number; minimum?: number; maximum?: number }][]) {
    const v = a[k]; if (v === undefined) continue
    if (spec.type === 'string' && (typeof v !== 'string' || (spec.maxLength !== undefined && v.length > spec.maxLength))) return { ok: false, error: 'bad_arguments', detail: k }
    if (spec.type === 'integer' && (!Number.isInteger(v) || (spec.minimum !== undefined && (v as number) < spec.minimum) || (spec.maximum !== undefined && (v as number) > spec.maximum))) return { ok: false, error: 'bad_arguments', detail: k }
  }
  const fn = h[name]; if (!fn) return { ok: false, error: 'unavailable', detail: 'this deployment has not enabled that tool' }
  try { return { ok: true, data: await fn(p, a), untrusted_content: true } } catch (e) { return e instanceof ScopeError ? { ok: false, error: 'bad_arguments', detail: e.message } : { ok: false, error: 'unavailable' } }
}
