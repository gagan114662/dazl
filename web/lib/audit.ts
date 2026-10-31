// Durable audit trail (#371): who did what to which resource in which workspace, when, under which request, and
// whether policy allowed it. Append-only in the database itself: an UPDATE is refused by a trigger, and a DELETE is
// refused except inside the retention purge's own transaction (the audit_purge_gate row exists only there). No API
// writes or edits events; members read them through GET /api/workspace/audit, scoped to their own workspace.
// Automatic deletion is OFF until the owner chooses a retention period (auditRetention, below).
//
// Summaries are redacted at the source: only short scalar fields are kept, and any field whose name or value looks
// like a credential, a token or message content is dropped, so secret values and reply bodies never enter the trail.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { captureError } from './ops/errors.ts'

// SQLite: migrateAuth (lib/auth-db.ts); PG: 0025_audit_events.sql.
export const AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL CHECK (length(actor_id) <= 80),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service', 'support')),
    action TEXT NOT NULL CHECK (length(action) <= 64),
    resource_type TEXT NOT NULL CHECK (length(resource_type) <= 40),
    resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 80),
    decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
    summary TEXT NOT NULL DEFAULT '{}' CHECK (length(summary) <= 2000),
    correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) <= 80),
    at INTEGER NOT NULL,
    seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_events_tenant_at ON audit_events (tenant_id, at);
  CREATE INDEX IF NOT EXISTS audit_events_seq ON audit_events (seq);
  CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at);
  CREATE TABLE IF NOT EXISTS audit_purge_gate (id INTEGER PRIMARY KEY CHECK (id = 1));
  CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
    WHEN NOT EXISTS (SELECT 1 FROM audit_purge_gate)
    BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
`

export type AuditEvent = {
  tenantId: string
  actorId: string
  actorKind?: 'user' | 'service' | 'support'
  action: string
  resourceType: string
  resourceId?: string | null
  decision?: 'allowed' | 'denied'
  summary?: Record<string, unknown>
  correlationId?: string | null
}

// What a caller may pass for the request it acts in.
export type AuditCtx = { correlationId?: string | null }

const DROP_KEY = /secret|token|key|password|passwd|hash|salt|cookie|authorization|credential|body|text|content|html|message|reply|snippet/i
const SECRETISH = /^[A-Za-z0-9+/=_-]{32,}$/
const SUMMARY_MAX = 2000 // the column's CHECK
// Short scalars only; anything that could be a secret or message content is dropped, not truncated. Fields past what
// the column holds are dropped too, so a large summary never makes the event itself fail to write.
export function redact(summary: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(summary ?? {}).slice(0, 20)) {
    if (DROP_KEY.test(k) || !/^[a-z][a-z0-9_]{0,39}$/i.test(k)) continue
    let keep: string | number | boolean | null | undefined
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) keep = v
    else if (typeof v === 'string' && v.length <= 120 && !SECRETISH.test(v) && !/^(sk|pk|rk)[-_]/i.test(v)) keep = v
    if (keep === undefined || JSON.stringify({ ...out, [k]: keep }).length > SUMMARY_MAX) continue
    out[k] = keep
  }
  return out
}

const nowS = () => Math.floor(Date.now() / 1000)
const row = (e: AuditEvent, now: number) => [randomBytes(12).toString('hex'), e.tenantId, e.actorId.slice(0, 80), e.actorKind ?? 'user', e.action.slice(0, 64),
  e.resourceType.slice(0, 40), e.resourceId?.slice(0, 80) ?? null, e.decision ?? 'allowed', JSON.stringify(redact(e.summary)), e.correlationId?.slice(0, 80) ?? null, now]
// seq orders events written in the same second (assigned in the INSERT itself: an insert-then-update stamp would be
// refused by the no-update trigger). Two concurrent writers may share a seq; they then tie, never fail.
const INSERT = `INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, resource_id, decision, summary, correlation_id, at, seq)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM audit_events))`

// Inside the transaction that makes the change: the event commits with it, or neither does.
export function* recordTx(t: Tx, e: AuditEvent, now = nowS()): TxBody<void> {
  yield* t.run(INSERT, row(e, now))
}
// On its own: for refusals (nothing else is written) and for changes made outside a Db transaction.
export async function record(db: Db, e: AuditEvent, now = nowS()): Promise<void> {
  await db.run(INSERT, row(e, now))
}

export type AuditRow = { id: string; actor_id: string; actor_kind: string; action: string; resource_type: string; resource_id: string | null; decision: string; summary: Record<string, unknown>; correlation_id: string | null; at: number; seq: number }

// A page boundary is the last row's (at, seq, id), the same order the query sorts by, so the next page starts exactly
// after it: events written in the same second as the boundary are neither skipped nor repeated.
export type AuditCursor = { at: number; seq: number; id: string }
export const cursorOf = (r: AuditRow): string => `${r.at}.${r.seq}.${r.id}`
export function parseCursor(s: string | null | undefined): AuditCursor | null {
  const m = /^(\d{1,12})\.(\d{1,15})\.([a-f0-9]{24})$/.exec(s ?? '')
  return m ? { at: Number(m[1]), seq: Number(m[2]), id: m[3] } : null
}

// One workspace's events, newest first. The tenant always comes from the caller's session, never from the query.
export async function searchAudit(db: Db, tenantId: string, q: { action?: string; actor?: string; after?: AuditCursor | null; limit?: number } = {}): Promise<AuditRow[]> {
  const where = ['tenant_id = ?'], params: (string | number)[] = [tenantId]
  // action is a prefix ("credential." matches credential.saved and credential.removed), matched literally
  if (q.action) { where.push("action LIKE ? ESCAPE '\\'"); params.push(`${q.action.replace(/[%_\\]/g, c => `\\${c}`)}%`) }
  if (q.actor) { where.push('actor_id = ?'); params.push(q.actor) }
  if (q.after) {
    where.push('(at < ? OR (at = ? AND (seq < ? OR (seq = ? AND id < ?))))')
    params.push(q.after.at, q.after.at, q.after.seq, q.after.seq, q.after.id)
  }
  const limit = Math.max(1, Math.min(q.limit ?? 100, 1000))
  const rows = await db.all<Omit<AuditRow, 'summary'> & { summary: string }>(
    `SELECT id, actor_id, actor_kind, action, resource_type, resource_id, decision, summary, correlation_id, at, seq FROM audit_events
     WHERE ${where.join(' AND ')} ORDER BY at DESC, seq DESC, id DESC LIMIT ${limit}`, params)
  // a summary that does not parse (the column is written by this module only, so this is corruption) is reported and
  // shown as unreadable rather than silently empty
  return rows.map(r => ({ ...r, at: Number(r.at), seq: Number(r.seq), summary: (() => {
    try { return JSON.parse(r.summary) as Record<string, unknown> } catch (e) { captureError(e, { source: 'route', where: 'audit:summary', tenantId }); return { unreadable: true } }
  })() }))
}

// Retention policy. Automatic deletion is OFF until the owner chooses a period: a deployment never picks one on its own
// (the rule lib/account-retention.ts follows for sessions). AUDIT_RETENTION_DAYS is that choice, a whole number of days
// of at least AUDIT_RETENTION_MIN_DAYS. Unset, empty, 'off' and '0' are off; anything else ('abc', '-5', '1.5', '29',
// '400d') is invalid. Off and invalid both purge nothing; the tick reports invalid, so a typo never quietly deletes
// and never quietly passes for a policy.
export const AUDIT_RETENTION_MIN_DAYS = 30
export type AuditRetention = { state: 'off' } | { state: 'invalid' } | { state: 'on'; days: number; retainS: number }
export function auditRetention(env: Record<string, string | undefined> = process.env): AuditRetention {
  const raw = (env.AUDIT_RETENTION_DAYS ?? '').trim()
  if (raw === '' || raw === '0' || raw.toLowerCase() === 'off') return { state: 'off' }
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) < AUDIT_RETENTION_MIN_DAYS) return { state: 'invalid' }
  const days = Number(raw)
  return { state: 'on', days, retainS: days * 24 * 60 * 60 }
}

// The purge path for an explicit policy: events older than `retainS`, at most `limit` per call (1000 by default, never
// more than 10000), inside the only transaction the delete trigger allows. `retainS` is required and must be a period
// auditRetention would accept: there is no default, so nothing can purge by omission. Run from the scheduled tick,
// fenced by its lease (`fence` runs first in the same transaction: a lost lease refuses the whole purge, and the gate
// row is never left behind).
export async function purgeAudit(db: Db, o: { retainS: number; now?: number; limit?: number; fence?: (t: Tx) => TxBody<void> }): Promise<number> {
  if (!Number.isInteger(o.retainS) || o.retainS < AUDIT_RETENTION_MIN_DAYS * 24 * 60 * 60) throw new Error('audit purge needs an explicit retention period')
  const cutoff = (o.now ?? nowS()) - o.retainS, limit = Math.max(1, Math.min(o.limit ?? 1000, 10000))
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    yield* t.run('INSERT INTO audit_purge_gate (id) VALUES (1)')
    const r = yield* t.run('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE at < ? ORDER BY at LIMIT ?)', [cutoff, limit])
    yield* t.run('DELETE FROM audit_purge_gate WHERE id = 1')
    return r.changes
  })
}
