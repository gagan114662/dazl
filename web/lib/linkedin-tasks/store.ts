// The dazl LinkedIn extension's task queue (#1122). dazl never reads LinkedIn from its servers: a scan ENQUEUES a read task, the
// user's own browser extension asks for the next one (GET /api/tasks/next), opens that one page in the user's signed-in session,
// reads it, and posts what it read (POST /api/tasks/complete). Every pacing rule is decided HERE, inside one transaction per
// request, so the extension can never read faster, outside working hours, more than the daily cap, or two pages at once:
//   - no time zone set for the workspace -> nothing is served (fail closed);
//   - outside 09:00-16:59 in that zone -> nothing is served;
//   - a task already out and not expired -> nothing else is served (one at a time);
//   - before the random 45-180 s pause since the last served task -> nothing is served;
//   - 40 tasks served in the last 24 hours -> nothing is served;
//   - a "blocked" / "challenge" report from the extension -> nothing is served for 24 hours.
// Results are DATA (names, titles, public profile URLs, the page read and when). They prove nothing alone: a person found here is
// a candidate buyer that still passes the normal buyer bar. Db layer: SQLite and Postgres.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { LIMITS, MAX_PEOPLE, endOfLocalDay, inWorkingHours, isTaskKind, nextGapS, personOk, taskUrlOk, validZone, type ReadPerson, type TaskKind } from './limits.ts'

export function migrateLiTasks(db: Database.Database): void {
  const first = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'li_task_gate'").get()
  db.exec(`
    CREATE TABLE IF NOT EXISTS li_tasks (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL,
      requested_by TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, created_at INTEGER NOT NULL, served_at INTEGER, done_at INTEGER, outcome TEXT);
    CREATE INDEX IF NOT EXISTS li_tasks_queue ON li_tasks (tenant_id, status, created_at);
    CREATE INDEX IF NOT EXISTS li_tasks_served ON li_tasks (tenant_id, served_at);
    CREATE TABLE IF NOT EXISTS li_results (task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, source_url TEXT NOT NULL, fetched_at INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS li_results_tenant ON li_results (tenant_id, fetched_at);
    CREATE TABLE IF NOT EXISTS li_ext_tokens (tenant_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
    CREATE TABLE IF NOT EXISTS li_task_gate (tenant_id TEXT PRIMARY KEY, tz TEXT, next_allowed_at INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
      open_min INTEGER NOT NULL DEFAULT 540, close_min INTEGER NOT NULL DEFAULT 1020, override_close_min INTEGER, override_until INTEGER);`)
  // Owner brief 2026-11-22 (#1122): LinkedIn is read only in the user's browser; the server keeps no LinkedIn session. The saved
  // li_at/JSESSIONID session credentials ('adv:linkedin' rows, and only those) are deleted; nothing writes them any more.
  // Once, when this migration first runs (as the Postgres migration 0072 does once).
  if (first && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tenant_connectors'").get()) db.exec("DELETE FROM tenant_connectors WHERE connector = 'adv:linkedin'")
}

const nowS = () => Math.floor(Date.now() / 1000)
const newId = () => randomBytes(12).toString('base64url')
export const DEDUPE_S = 7 * 86_400   // the same page for the same workspace is read at most once a week
export const COOLDOWN_S = 86_400     // after LinkedIn blocks or challenges the session

// The extension token (Settings > LinkedIn extension). One per workspace: creating a new one replaces (revokes) the old one,
// Revoke deletes it. Only its SHA-256 is stored; the token itself is shown once. Format: `dzx_<tenantId>.<32 random bytes>`.
const TOKEN = /^dzx_([A-Za-z0-9_-]{1,80})\.([A-Za-z0-9_-]{43})$/
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export async function createExtensionToken(db: Db, tenantId: string, userId: string, tz: unknown, now = nowS()): Promise<string> {
  const token = `dzx_${tenantId}.${randomBytes(32).toString('base64url')}`
  await db.run('INSERT INTO li_ext_tokens (tenant_id, token_hash, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id) DO UPDATE SET token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = excluded.created_at, last_used_at = NULL', [tenantId, hash(token), userId, now])
  // The working-hours zone is the one of the member who created the token (their browser), set here and never by the extension.
  await setTimezone(db, tenantId, tz)
  return token
}
export async function revokeExtensionToken(db: Db, tenantId: string): Promise<boolean> {
  return (await db.run('DELETE FROM li_ext_tokens WHERE tenant_id = ?', [tenantId])).changes > 0
}
// The workspace a token belongs to, or null (malformed, unknown, revoked or replaced). Constant-time compare of the hashes.
export async function authExtensionToken(db: Db, token: unknown, now = nowS()): Promise<string | null> {
  const m = typeof token === 'string' ? TOKEN.exec(token.trim()) : null
  if (!m) return null
  const row = await db.get<{ token_hash: string }>('SELECT token_hash FROM li_ext_tokens WHERE tenant_id = ?', [m[1]])
  if (!row) return null
  const a = Buffer.from(row.token_hash, 'hex'), b = Buffer.from(hash(token as string), 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  await db.run('UPDATE li_ext_tokens SET last_used_at = ? WHERE tenant_id = ?', [now, m[1]])
  return m[1]
}
export async function extensionStatus(db: Db, tenantId: string): Promise<{ token: boolean; created_at: number | null; last_used_at: number | null; tz: string | null; paused: boolean; queued: number; read_today: number; open_min: number; close_min: number; today_close_min: number | null; stopped_until: number | null }> {
  const t = await db.get<{ created_at: number; last_used_at: number | null }>('SELECT created_at, last_used_at FROM li_ext_tokens WHERE tenant_id = ?', [tenantId])
  const g = await db.get<{ tz: string | null; paused: number; open_min: number; close_min: number; override_close_min: number | null; override_until: number | null; next_allowed_at: number }>('SELECT tz, paused, open_min, close_min, override_close_min, override_until, next_allowed_at FROM li_task_gate WHERE tenant_id = ?', [tenantId])
  const q = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM li_tasks WHERE tenant_id = ? AND status = 'queued'", [tenantId])
  const d = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM li_tasks WHERE tenant_id = ? AND served_at IS NOT NULL AND served_at > ?', [tenantId, nowS() - 86_400])
  return { token: !!t, created_at: t ? Number(t.created_at) : null, last_used_at: t?.last_used_at == null ? null : Number(t.last_used_at), tz: g?.tz ?? null, paused: Number(g?.paused ?? 0) === 1, open_min: Number(g?.open_min ?? LIMITS.openMin), close_min: Number(g?.close_min ?? LIMITS.closeMin),
    today_close_min: g?.override_until != null && Number(g.override_until) >= nowS() ? Number(g.override_close_min) : null,
    stopped_until: Number(g?.next_allowed_at ?? 0) - nowS() > LIMITS.maxGapS ? Number(g!.next_allowed_at) : null, queued: Number(q?.n ?? 0), read_today: Number(d?.n ?? 0) }
}

export async function setTimezone(db: Db, tenantId: string, tz: unknown): Promise<boolean> {
  const z = validZone(tz)
  if (!z) return false
  await db.run('INSERT INTO li_task_gate (tenant_id, tz) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET tz = excluded.tz', [tenantId, z])
  return true
}
// The workspace's reading window (minutes of the local day). close must be after open.
export async function setWindow(db: Db, tenantId: string, openMin: number, closeMin: number): Promise<boolean> {
  if (!Number.isInteger(openMin) || !Number.isInteger(closeMin) || openMin < 0 || closeMin > 1440 || closeMin <= openMin) return false
  await db.run('INSERT INTO li_task_gate (tenant_id, open_min, close_min) VALUES (?, ?, ?) ON CONFLICT (tenant_id) DO UPDATE SET open_min = excluded.open_min, close_min = excluded.close_min', [tenantId, openMin, closeMin])
  return true
}
// A later close for TODAY only (local day of the workspace's zone); the normal window comes back by itself after midnight.
export async function extendToday(db: Db, tenantId: string, closeMin: number, now = nowS()): Promise<number | null> {
  const g = await db.get<{ tz: string | null }>('SELECT tz FROM li_task_gate WHERE tenant_id = ?', [tenantId])
  const tz = validZone(g?.tz)
  if (!tz || !Number.isInteger(closeMin) || closeMin < 0 || closeMin > 1440) return null
  const until = endOfLocalDay(now, tz)
  await db.run('UPDATE li_task_gate SET override_close_min = ?, override_until = ? WHERE tenant_id = ?', [closeMin, until, tenantId])
  return until
}
export async function setPaused(db: Db, tenantId: string, paused: boolean): Promise<void> {
  await db.run('INSERT INTO li_task_gate (tenant_id, paused) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET paused = excluded.paused', [tenantId, paused ? 1 : 0])
}

// Queue one read. Returns the task id, or null for a URL the kind may not open or a page already queued/read this week.
export async function enqueueTask(db: Db, tenantId: string, kind: TaskKind, rawUrl: unknown, requestedBy: string | null, now = nowS()): Promise<string | null> {
  if (!isTaskKind(kind)) return null
  const url = taskUrlOk(kind, rawUrl)
  if (!url) return null
  const id = newId()
  return db.tx(function* (t: Tx): TxBody<string | null> {
    const dup = yield* t.get<{ id: string }>("SELECT id FROM li_tasks WHERE tenant_id = ? AND kind = ? AND url = ? AND status <> 'failed' AND created_at > ?", [tenantId, kind, url, now - DEDUPE_S])
    if (dup) return null
    yield* t.run("INSERT INTO li_tasks (id, tenant_id, kind, url, status, requested_by, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)", [id, tenantId, kind, url, requestedBy, now])
    return id
  })
}

export type NextResult = { task: { id: string; kind: TaskKind; url: string; lease_until: number } } | { wait: 'no_timezone' | 'paused' | 'outside_hours' | 'one_at_a_time' | 'pause_between_tasks' | 'daily_cap' | 'cooldown' | 'empty'; retry_after_s: number }

export async function nextTask(db: Db, tenantId: string, now = nowS(), rand: () => number = Math.random): Promise<NextResult> {
  return db.tx(function* (t: Tx): TxBody<NextResult> {
    // The gate row is the per-workspace lock: every serve updates it, so two concurrent asks are serialized (row lock on Postgres; one writer on SQLite).
    yield* t.run('INSERT INTO li_task_gate (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO UPDATE SET next_allowed_at = li_task_gate.next_allowed_at', [tenantId])
    const g = yield* t.get<{ tz: string | null; next_allowed_at: number; paused: number; open_min: number; close_min: number; override_close_min: number | null; override_until: number | null }>('SELECT tz, next_allowed_at, paused, open_min, close_min, override_close_min, override_until FROM li_task_gate WHERE tenant_id = ?', [tenantId])
    const tz = validZone(g?.tz)
    if (!tz) return { wait: 'no_timezone', retry_after_s: 3600 }
    if (Number(g?.paused ?? 0) === 1) return { wait: 'paused', retry_after_s: 600 }
    // Expired leases: handed out again once, then failed.
    yield* t.run("UPDATE li_tasks SET status = 'failed', outcome = 'lease_expired', done_at = ? WHERE tenant_id = ? AND status = 'leased' AND lease_until <= ? AND attempts >= ?", [now, tenantId, now, LIMITS.maxAttempts])
    yield* t.run("UPDATE li_tasks SET status = 'queued', lease_until = NULL WHERE tenant_id = ? AND status = 'leased' AND lease_until <= ?", [tenantId, now])
    const out = yield* t.get<{ lease_until: number }>("SELECT lease_until FROM li_tasks WHERE tenant_id = ? AND status = 'leased' ORDER BY lease_until DESC LIMIT 1", [tenantId])
    if (out) return { wait: 'one_at_a_time', retry_after_s: Math.max(1, Number(out.lease_until) - now) }
    const next = Number(g?.next_allowed_at ?? 0)
    if (now < next) return { wait: next - now > LIMITS.maxGapS ? 'cooldown' : 'pause_between_tasks', retry_after_s: next - now }
    const win = { openMin: Number(g?.open_min ?? LIMITS.openMin), closeMin: Number(g?.close_min ?? LIMITS.closeMin), overrideCloseMin: g?.override_close_min == null ? null : Number(g.override_close_min), overrideUntil: g?.override_until == null ? null : Number(g.override_until) }
    if (!inWorkingHours(now, tz, win)) return { wait: 'outside_hours', retry_after_s: 900 }
    const served = yield* t.get<{ n: number }>('SELECT COUNT(*) AS n FROM li_tasks WHERE tenant_id = ? AND served_at IS NOT NULL AND served_at > ?', [tenantId, now - 86_400])
    if (Number(served?.n ?? 0) >= LIMITS.viewsPerDay) return { wait: 'daily_cap', retry_after_s: 3600 }
    const q = yield* t.get<{ id: string; kind: string; url: string }>("SELECT id, kind, url FROM li_tasks WHERE tenant_id = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1", [tenantId])
    if (!q || !isTaskKind(q.kind)) return { wait: 'empty', retry_after_s: 120 }
    const leaseUntil = now + LIMITS.leaseS
    yield* t.run("UPDATE li_tasks SET status = 'leased', attempts = attempts + 1, lease_until = ?, served_at = ? WHERE id = ? AND tenant_id = ? AND status = 'queued'", [leaseUntil, now, q.id, tenantId])
    yield* t.run('UPDATE li_task_gate SET next_allowed_at = ? WHERE tenant_id = ?', [now + nextGapS(rand), tenantId])
    return { task: { id: q.id, kind: q.kind, url: q.url, lease_until: leaseUntil } }
  })
}

// What the extension may report. A read: the people it saw (company People page, post reactors/commenters) or the one person
// (profile). A failure: one of the named reasons; "blocked" and "challenge" stop every read for this workspace for a day.
export const FAILURES = ['login_required', 'not_found', 'blocked', 'challenge', 'throttled', 'extract_failed'] as const
type Failure = typeof FAILURES[number]
export type CompleteBody = { people?: unknown; person?: unknown; error?: unknown }
export type Parsed = { ok: true; people: ReadPerson[] } | { ok: false; error: Failure } | null

export function parseResult(kind: TaskKind, body: CompleteBody): Parsed {
  if (!body || typeof body !== 'object') return null
  if (body.error !== undefined) return (FAILURES as readonly unknown[]).includes(body.error) ? { ok: false, error: body.error as Failure } : null
  if (kind === 'profile') { const p = personOk(body.person); return p ? { ok: true, people: [p] } : null }
  if (!Array.isArray(body.people) || body.people.length > MAX_PEOPLE) return null
  const seen = new Set<string>(), people: ReadPerson[] = []
  for (const raw of body.people) { const p = personOk(raw); if (p && !seen.has(p.profile_url)) { seen.add(p.profile_url); people.push(p) } }
  return { ok: true, people }
}

export type CompleteResult = 'stored' | 'failed_recorded' | 'not_leased' | 'bad_result'
export async function completeTask(db: Db, tenantId: string, taskId: unknown, body: CompleteBody, now = nowS()): Promise<CompleteResult> {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(taskId)) return 'not_leased'
  return db.tx(function* (t: Tx): TxBody<CompleteResult> {
    // Only THIS workspace's task, and only while it is out: a stale, foreign or already-finished task stores nothing.
    const task = yield* t.get<{ kind: string; url: string }>("SELECT kind, url FROM li_tasks WHERE id = ? AND tenant_id = ? AND status = 'leased'", [taskId, tenantId])
    if (!task || !isTaskKind(task.kind)) return 'not_leased'
    const r = parseResult(task.kind, body)
    if (!r) return 'bad_result'
    if (!r.ok) {
      yield* t.run("UPDATE li_tasks SET status = 'failed', outcome = ?, done_at = ?, lease_until = NULL WHERE id = ? AND tenant_id = ?", [r.error, now, taskId, tenantId])
      if (r.error === 'blocked' || r.error === 'challenge' || r.error === 'throttled') yield* t.run('UPDATE li_task_gate SET next_allowed_at = ? WHERE tenant_id = ?', [now + COOLDOWN_S, tenantId])
      return 'failed_recorded'
    }
    yield* t.run('INSERT INTO li_results (task_id, tenant_id, kind, source_url, fetched_at, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (task_id) DO NOTHING', [taskId, tenantId, task.kind, task.url, now, JSON.stringify({ people: r.people })])
    yield* t.run("UPDATE li_tasks SET status = 'done', outcome = ?, done_at = ?, lease_until = NULL WHERE id = ? AND tenant_id = ?", [r.people.length ? 'ok' : 'empty', now, taskId, tenantId])
    return 'stored'
  })
}

export async function resultsFor(db: Db, tenantId: string, sourceUrl: string): Promise<{ fetched_at: number; people: ReadPerson[] }[]> {
  const rows = await db.all<{ fetched_at: number; payload: string }>('SELECT fetched_at, payload FROM li_results WHERE tenant_id = ? AND source_url = ? ORDER BY fetched_at DESC', [tenantId, sourceUrl])
  return rows.map(r => { try { return { fetched_at: Number(r.fetched_at), people: (JSON.parse(r.payload) as { people: ReadPerson[] }).people ?? [] } } catch { return { fetched_at: Number(r.fetched_at), people: [] } } })
}
