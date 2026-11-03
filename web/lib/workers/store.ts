// Runtime worker catalog and lifecycle (docs/design/runtime-workers.md). Operator-only: nothing here is reachable from a
// tenant request; scripts/workers.mts is the surface, run on the host. Every change and every refusal is written to
// worker_events (append-only) with the actor, worker name, version and code hash.
//
//   worker_catalog      one immutable row per registered (name, version): the reviewed code's hash and its definition.
//   worker_deployments  one row per worker name: the active version, its state, its generation (the fence) and the
//                       limits every instance enforces (read from here on each claim, so they are global, not per process).
//   worker_grants       the per-tenant allowlist: a tenant can enqueue a worker only once an operator granted it.
//   worker_runs         a tenant's runs: input, then output or error, written only by the claim that still owns them.
//
// Registration grants nothing: a worker runs only when its version is deployed and running, a tenant can use it only
// when granted, and a worker whose effect or permissions this runtime cannot provide is refused at start
// (definition.ts unrunnable).
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { recordTx } from '../audit.ts'
import { fenceKindIn } from '../queue/db.ts'
import { checkDefinition, fileHash, HASH_RE, key, LIMIT_BOUNDS, NAME_RE, unrunnable, VERSION_RE, type Limits, type Registry, type WorkerDefinition } from './definition.ts'

// SQLite DDL; PG: 0051_runtime_workers.sql (the generated translation).
export const WORKERS_DDL = `
  CREATE TABLE IF NOT EXISTS worker_catalog (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
    effect TEXT NOT NULL CHECK (effect IN ('none', 'draft', 'send', 'spend')),
    state_version INTEGER NOT NULL,
    definition TEXT NOT NULL CHECK (length(definition) <= 65536),
    registered_by TEXT NOT NULL CHECK (length(registered_by) <= 80),
    registered_at INTEGER NOT NULL,
    PRIMARY KEY (name, version)
  );
  CREATE TABLE IF NOT EXISTS worker_deployments (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'draining', 'stopped', 'failed')),
    generation INTEGER NOT NULL,
    max_in_flight INTEGER NOT NULL,
    per_tenant_in_flight INTEGER NOT NULL,
    max_backlog INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    drain_deadline INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    restarts INTEGER NOT NULL DEFAULT 0,
    restart_after INTEGER,
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL CHECK (length(updated_by) <= 80)
  );
  CREATE TABLE IF NOT EXISTS worker_events (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL CHECK (length(actor) <= 80),
    action TEXT NOT NULL CHECK (length(action) <= 40),
    decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
    name TEXT CHECK (name IS NULL OR length(name) <= 40),
    version TEXT CHECK (version IS NULL OR length(version) <= 20),
    code_hash TEXT CHECK (code_hash IS NULL OR length(code_hash) = 64),
    generation INTEGER,
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 200)
  );
  CREATE INDEX IF NOT EXISTS worker_events_at ON worker_events (at);
  CREATE TRIGGER IF NOT EXISTS worker_events_no_update BEFORE UPDATE ON worker_events BEGIN SELECT RAISE(ABORT, 'worker events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS worker_events_no_delete BEFORE DELETE ON worker_events BEGIN SELECT RAISE(ABORT, 'worker events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS worker_catalog_no_update BEFORE UPDATE ON worker_catalog BEGIN SELECT RAISE(ABORT, 'worker catalog entries are immutable'); END;
  CREATE TABLE IF NOT EXISTS worker_grants (
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    granted_by TEXT NOT NULL CHECK (length(granted_by) <= 80),
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, name)
  );
  CREATE TABLE IF NOT EXISTS worker_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    actor_id TEXT NOT NULL CHECK (length(actor_id) <= 80),
    status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'failed', 'refused')),
    input TEXT NOT NULL CHECK (length(input) <= 65536),
    version TEXT,
    generation INTEGER,
    output TEXT CHECK (output IS NULL OR length(output) <= 65536),
    error TEXT CHECK (error IS NULL OR length(error) <= 200),
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS worker_runs_tenant ON worker_runs (tenant_id, created_at);
`

export function migrateWorkers(db: Database.Database): void { db.exec(WORKERS_DDL) }

export type WorkerErrorCode =
  | 'bad_actor' | 'bad_request' | 'unreviewed' | 'hash_mismatch' | 'bad_definition' | 'immutable' | 'unknown'
  | 'unrunnable' | 'exists' | 'not_deployed' | 'incompatible_state' | 'not_older' | 'not_newer' | 'no_tenant' | 'bad_limits'
export class WorkerError extends Error {
  code: WorkerErrorCode
  constructor(code: WorkerErrorCode, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.code = code }
}

export type DeploymentState = 'running' | 'draining' | 'stopped' | 'failed'
export interface Deployment {
  name: string; version: string; state: DeploymentState; generation: number
  maxInFlight: number; perTenantInFlight: number; maxBacklog: number; maxAttempts: number
  drainDeadline: number | null; failures: number; restarts: number; restartAfter: number | null; reason: string | null
  updatedAt: number; updatedBy: string
}
type DepRow = {
  name: string; version: string; state: DeploymentState; generation: number; max_in_flight: number; per_tenant_in_flight: number
  max_backlog: number; max_attempts: number; drain_deadline: number | null; failures: number; restarts: number
  restart_after: number | null; reason: string | null; updated_at: number; updated_by: string
}
const n = (v: unknown) => v === null || v === undefined ? null : Number(v)
export function toDeployment(r: DepRow): Deployment {
  return {
    name: r.name, version: r.version, state: r.state, generation: Number(r.generation), maxInFlight: Number(r.max_in_flight),
    perTenantInFlight: Number(r.per_tenant_in_flight), maxBacklog: Number(r.max_backlog), maxAttempts: Number(r.max_attempts),
    drainDeadline: n(r.drain_deadline), failures: Number(r.failures), restarts: Number(r.restarts), restartAfter: n(r.restart_after),
    reason: r.reason, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
  }
}

export const kindOf = (name: string) => `worker:${name}`
export const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,79}$/
const nowS = () => Math.floor(Date.now() / 1000)
const clip = (s: string, max: number) => s.length > max ? s.slice(0, max) : s
const okName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v)
const okVersion = (v: unknown): v is string => typeof v === 'string' && VERSION_RE.test(v)
const semver = (v: string) => v.split('.').map(Number)
export function compareVersions(a: string, b: string): number {
  const x = semver(a), y = semver(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

type Ev = { actor: string; action: string; decision?: 'allowed' | 'denied'; name?: unknown; version?: unknown; codeHash?: unknown; generation?: number | null; detail?: string | null }
// Event ids sort in write order: milliseconds, then a per-process counter, then randomness (two processes writing in
// the same millisecond tie-break arbitrarily, still a valid order).
let evSeq = 0
const evId = () => `${Date.now().toString(16).padStart(12, '0')}${(evSeq++ % 65536).toString(16).padStart(4, '0')}${randomBytes(6).toString('hex')}`
const evArgs = (e: Ev, now: number) => [
  evId(), now, clip(ACTOR_RE.test(e.actor) ? e.actor : 'invalid-actor', 80), clip(e.action, 40), e.decision ?? 'allowed',
  okName(e.name) ? e.name : null, okVersion(e.version) ? e.version : null,
  typeof e.codeHash === 'string' && HASH_RE.test(e.codeHash) ? e.codeHash : null, e.generation ?? null, e.detail ? clip(e.detail, 200) : null,
]
const EV_SQL = 'INSERT INTO worker_events (id, at, actor, action, decision, name, version, code_hash, generation, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
export function* eventIn(t: Tx, e: Ev, now = nowS()): TxBody<void> { yield* t.run(EV_SQL, evArgs(e, now)) }
export async function event(db: Db, e: Ev, now = nowS()): Promise<void> { await db.run(EV_SQL, evArgs(e, now)) }

// A refusal: recorded (its own write, since the refused change wrote nothing), then thrown. If even the record cannot
// be written the refusal still stands: the write error is thrown instead, never swallowed into a success.
async function refuse(db: Db, e: Omit<Ev, 'decision'>, code: WorkerErrorCode, detail?: string): Promise<never> {
  await event(db, { ...e, decision: 'denied', detail: detail ? `${code}: ${detail}` : code })
  throw new WorkerError(code, detail)
}
// The operator acting. An unusable actor is refused and recorded as 'invalid-actor'.
async function checkActor(db: Db, actor: unknown, action: string): Promise<void> {
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) await refuse(db, { actor: 'invalid-actor', action }, 'bad_actor')
}

type CatRow = { name: string; version: string; code_hash: string; effect: string; state_version: number; definition: string }
async function catalogEntry(db: Db, name: string, version: string): Promise<CatRow | undefined> {
  return db.get<CatRow>('SELECT name, version, code_hash, effect, state_version, definition FROM worker_catalog WHERE name = ? AND version = ?', [name, version])
}
// A stored definition, re-checked on every read: a row edited behind the app's back is refused, never trusted.
export function storedDefinition(r: CatRow): WorkerDefinition | null {
  let d: unknown
  try { d = JSON.parse(r.definition) } catch { return null }
  if (checkDefinition(d)) return null
  const def = d as WorkerDefinition
  return def.name === r.name && def.version === r.version && def.effect === r.effect && def.stateVersion === Number(r.state_version) ? def : null
}

// Register a reviewed (name, version) at runtime. The caller names the code hash it reviewed; it must equal both the
// hash pinned in the registry at review time and the hash of the file on disk now. Registering the same entry again
// is a no-op; a different hash under a registered (name, version) is refused (entries are immutable).
export async function register(db: Db, actor: string, req: { name: unknown; version: unknown; codeHash: unknown }, registry: Registry, now = nowS()): Promise<{ created: boolean }> {
  await checkActor(db, actor, 'register')
  const base = { actor, action: 'register', name: req.name, version: req.version, codeHash: req.codeHash }
  if (!okName(req.name) || !okVersion(req.version) || typeof req.codeHash !== 'string' || !HASH_RE.test(req.codeHash)) return refuse(db, base, 'bad_request')
  const entry = registry.get(key(req.name, req.version))
  if (!entry) return refuse(db, base, 'unreviewed')
  const def = entry.module.definition
  const bad = checkDefinition(def)
  if (bad || def.name !== req.name || def.version !== req.version || typeof entry.module.run !== 'function') return refuse(db, base, 'bad_definition', bad ?? 'name/version/run mismatch')
  if (JSON.stringify(def).length > 65_536) return refuse(db, base, 'bad_definition', 'definition too large')
  const onDisk = fileHash(entry)
  if (req.codeHash !== entry.sha256 || onDisk !== entry.sha256) return refuse(db, base, 'hash_mismatch', onDisk === null ? 'file unreadable' : undefined)
  const prior = await catalogEntry(db, req.name, req.version)
  if (prior) {
    if (prior.code_hash !== req.codeHash) return refuse(db, base, 'immutable')
    return { created: false }
  }
  const name = req.name, version = req.version, codeHash = req.codeHash
  await db.tx(function* (t) {
    yield* t.run('INSERT INTO worker_catalog (name, version, code_hash, effect, state_version, definition, registered_by, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, version, codeHash, def.effect, def.stateVersion, JSON.stringify(def), actor, now])
    yield* eventIn(t, { ...base, detail: `effect=${def.effect}` }, now)
  })
  return { created: true }
}

const DEP_SQL = 'SELECT * FROM worker_deployments WHERE name = ?'
export async function deployment(db: Db, name: string): Promise<Deployment | null> {
  const r = await db.get<DepRow>(DEP_SQL, [name])
  return r ? toDeployment(r) : null
}
export async function deployments(db: Db): Promise<Deployment[]> {
  return (await db.all<DepRow>('SELECT * FROM worker_deployments ORDER BY name')).map(toDeployment)
}

// Start a registered version for the first time. Refused for a version this runtime cannot run (send/spend effects,
// or a permission it does not provide), and when the worker already has a deployment (use restart/upgrade/rollback).
export async function start(db: Db, actor: string, name: unknown, version: unknown, now = nowS()): Promise<Deployment> {
  await checkActor(db, actor, 'start')
  const base = { actor, action: 'start', name, version }
  if (!okName(name) || !okVersion(version)) return refuse(db, base, 'bad_request')
  const cat = await catalogEntry(db, name, version)
  if (!cat) return refuse(db, base, 'unknown')
  const def = storedDefinition(cat)
  if (!def) return refuse(db, { ...base, codeHash: cat.code_hash }, 'bad_definition')
  const why = unrunnable(def)
  if (why) return refuse(db, { ...base, codeHash: cat.code_hash }, 'unrunnable', why)
  const l = def.limits
  const made = await db.tx(function* (t): TxBody<boolean> {
    const r = yield* t.run(`INSERT INTO worker_deployments (name, version, state, generation, max_in_flight, per_tenant_in_flight, max_backlog, max_attempts, updated_at, updated_by)
      VALUES (?, ?, 'running', 1, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`, [name, version, l.maxInFlight, l.perTenantInFlight, l.maxBacklog, l.maxAttempts, now, actor])
    if (r.changes !== 1) return false
    yield* eventIn(t, { ...base, codeHash: cat.code_hash, generation: 1 }, now)
    return true
  })
  if (!made) return refuse(db, { ...base, codeHash: cat.code_hash }, 'exists')
  return (await deployment(db, name))!
}

// Move a worker to `to` inside one transaction: bump the generation (every completion from an older claim is now
// stale), and return its claimed items to pending so they are run again under the new generation. Queued items stay.
// With ifGeneration, nothing changes (null) unless the row is still at that generation: two hosts racing to act on
// the same observation change it once.
export type TransitionSet = { version?: string; state: DeploymentState; reason?: string | null; drainDeadline?: number | null; resetCounters?: boolean; restartAfter?: number | null; restarts?: number; ifGeneration?: number }
export function* transitionIn(t: Tx, name: string, set: TransitionSet, actor: string, now: number): TxBody<Deployment | null> {
  const fence = set.state !== 'draining'
  const row = yield* t.get<DepRow>(
    `UPDATE worker_deployments SET version = COALESCE(?, version), state = ?, generation = generation + ?, reason = ?, drain_deadline = ?,
       failures = CASE WHEN ? = 1 THEN 0 ELSE failures END, restarts = COALESCE(?, CASE WHEN ? = 1 THEN 0 ELSE restarts END),
       restart_after = ?, updated_at = ?, updated_by = ? WHERE name = ? AND generation = COALESCE(?, generation) RETURNING *`,
    [set.version ?? null, set.state, fence ? 1 : 0, set.reason ?? null, set.drainDeadline ?? null, set.resetCounters ? 1 : 0, set.restarts ?? null,
      set.resetCounters ? 1 : 0, set.restartAfter ?? null, now, actor, name, set.ifGeneration ?? null])
  if (!row) return null
  if (fence) yield* fenceKindIn(t, kindOf(name), now)
  return toDeployment(row)
}
function* transition(t: Tx, name: string, set: TransitionSet, actor: string, now: number): TxBody<Deployment> {
  const r = yield* transitionIn(t, name, set, actor, now)
  if (!r) throw new WorkerError('not_deployed')
  return r
}

async function current(db: Db, base: Omit<Ev, 'decision'>, name: unknown): Promise<Deployment> {
  if (!okName(name)) return refuse(db, base, 'bad_request')
  const d = await deployment(db, name)
  if (!d) return refuse(db, base, 'not_deployed')
  return d
}

// Stop a worker. 'drain' (default): no new claims; claims in flight may finish under the current generation, and the
// worker reads 'stopped' once none are left (settle), or is fenced when the drain deadline passes. 'fence': stopped
// now; claims in flight lose ownership (their completions are refused as stale) and go back to pending.
export async function stop(db: Db, actor: string, name: unknown, opts: { mode?: unknown; drainSeconds?: unknown } = {}, now = nowS()): Promise<Deployment> {
  await checkActor(db, actor, 'stop')
  const base = { actor, action: 'stop', name }
  const mode = opts.mode === undefined ? 'drain' : opts.mode
  const drainS = opts.drainSeconds === undefined ? 300 : opts.drainSeconds
  if ((mode !== 'drain' && mode !== 'fence') || typeof drainS !== 'number' || !Number.isInteger(drainS) || drainS < 1 || drainS > 3600) return refuse(db, base, 'bad_request')
  const d = await current(db, base, name)
  const n = d.name
  // Already stopped (or failed): a drain has nothing to wait for. Already draining: a second drain just settles.
  if (mode === 'drain' && d.state !== 'running') return d.state === 'draining' ? settle(db, n, now) : d
  const out = await db.tx(function* (t) {
    const r = mode === 'drain'
      ? yield* transition(t, n, { state: 'draining', drainDeadline: now + drainS, reason: 'operator stop (drain)' }, actor, now)
      : yield* transition(t, n, { state: 'stopped', reason: `operator stop (${mode})` }, actor, now)
    yield* eventIn(t, { ...base, version: r.version, generation: r.generation, detail: `mode=${mode}` }, now)
    return r
  })
  return mode === 'drain' ? settle(db, n, now) : out
}

// A draining worker becomes stopped once it has no claims left, or is fenced at its drain deadline. Called by the
// operator surface and by every worker host on each tick, so a drain completes without anyone watching it.
export async function settle(db: Db, name: string, now = nowS()): Promise<Deployment> {
  return db.tx(function* (t): TxBody<Deployment> {
    const r = yield* t.get<DepRow>(DEP_SQL, [name])
    if (!r) throw new WorkerError('not_deployed')
    const d = toDeployment(r)
    if (d.state !== 'draining') return d
    const busy = Number((yield* t.get<{ c: number }>("SELECT count(*) AS c FROM work_queue WHERE kind = ? AND status = 'claimed'", [kindOf(name)]))!.c)
    if (busy > 0 && (d.drainDeadline ?? 0) > now) return d
    const s = yield* transition(t, name, { state: 'stopped', reason: busy > 0 ? 'drain deadline passed: fenced' : 'drained' }, 'system', now)
    yield* eventIn(t, { actor: 'system', action: busy > 0 ? 'drain_fenced' : 'drained', name, version: s.version, generation: s.generation, detail: `claims=${busy}` }, now)
    return s
  })
}

// Restart: from any state, fence what is in flight and run the active version under a new generation, with the crash
// counters reset. Refused when the active version can no longer run here.
export async function restart(db: Db, actor: string, name: unknown, now = nowS()): Promise<Deployment> {
  await checkActor(db, actor, 'restart')
  const base = { actor, action: 'restart', name }
  const d = await current(db, base, name)
  const cat = await catalogEntry(db, d.name, d.version)
  const def = cat && storedDefinition(cat)
  if (!cat || !def) return refuse(db, { ...base, version: d.version }, 'bad_definition')
  const why = unrunnable(def)
  if (why) return refuse(db, { ...base, version: d.version, codeHash: cat.code_hash }, 'unrunnable', why)
  return db.tx(function* (t) {
    const r = yield* transition(t, d.name, { state: 'running', reason: 'operator restart', resetCounters: true }, actor, now)
    yield* eventIn(t, { ...base, version: r.version, codeHash: cat.code_hash, generation: r.generation }, now)
    return r
  })
}

// Switch the active version: upgrade (to a newer one) or rollback (to an older one). The target must be registered,
// runnable here, and keep the same stateVersion, so the queued inputs and stored runs it inherits are ones it can read.
// In-flight claims are fenced; queued work is kept and runs on the target version.
export async function activate(db: Db, actor: string, name: unknown, version: unknown, direction: 'upgrade' | 'rollback', now = nowS()): Promise<Deployment> {
  await checkActor(db, actor, direction)
  const base = { actor, action: direction, name, version }
  if (!okVersion(version)) return refuse(db, base, 'bad_request')
  const d = await current(db, base, name)
  const cmp = compareVersions(version, d.version)
  if (direction === 'rollback' && cmp >= 0) return refuse(db, base, 'not_older', `active ${d.version}`)
  if (direction === 'upgrade' && cmp <= 0) return refuse(db, base, 'not_newer', `active ${d.version}`)
  const [from, to] = [await catalogEntry(db, d.name, d.version), await catalogEntry(db, d.name, version)]
  if (!to) return refuse(db, base, 'unknown')
  const def = storedDefinition(to)
  if (!def) return refuse(db, { ...base, codeHash: to.code_hash }, 'bad_definition')
  const why = unrunnable(def)
  if (why) return refuse(db, { ...base, codeHash: to.code_hash }, 'unrunnable', why)
  if (!from || Number(from.state_version) !== def.stateVersion) return refuse(db, { ...base, codeHash: to.code_hash }, 'incompatible_state', `state ${from?.state_version ?? '?'} -> ${def.stateVersion}`)
  return db.tx(function* (t) {
    const r = yield* transition(t, d.name, { version, state: 'running', reason: `${direction} from ${d.version}`, resetCounters: true }, actor, now)
    yield* eventIn(t, { ...base, codeHash: to.code_hash, generation: r.generation, detail: `from=${d.version}` }, now)
    return r
  })
}

// Operator-set limits, enforced by every instance from this row: global in-flight, per-tenant in-flight, per-tenant
// backlog, attempts. Each must stay inside LIMIT_BOUNDS.
export async function setLimits(db: Db, actor: string, name: unknown, limits: unknown, now = nowS()): Promise<Deployment> {
  await checkActor(db, actor, 'limits')
  const base = { actor, action: 'limits', name }
  const l = limits as Partial<Limits>
  const keys = Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).length === 0 || Object.keys(limits).some(k => !(keys as string[]).includes(k))
    || keys.some(k => l[k] !== undefined && !(Number.isInteger(l[k]) && l[k]! >= LIMIT_BOUNDS[k][0] && l[k]! <= LIMIT_BOUNDS[k][1]))) return refuse(db, base, 'bad_limits')
  const d = await current(db, base, name)
  return db.tx(function* (t) {
    const r = (yield* t.get<DepRow>(`UPDATE worker_deployments SET max_in_flight = COALESCE(?, max_in_flight), per_tenant_in_flight = COALESCE(?, per_tenant_in_flight),
      max_backlog = COALESCE(?, max_backlog), max_attempts = COALESCE(?, max_attempts), updated_at = ?, updated_by = ? WHERE name = ? RETURNING *`,
      [l.maxInFlight ?? null, l.perTenantInFlight ?? null, l.maxBacklog ?? null, l.maxAttempts ?? null, now, actor, d.name]))!
    yield* eventIn(t, { ...base, version: d.version, generation: Number(r.generation), detail: keys.filter(k => l[k] !== undefined).map(k => `${k}=${l[k]}`).join(' ') }, now)
    return toDeployment(r)
  })
}

// The per-tenant allowlist. The tenant must exist (a workspace, or a personal workspace's founder id). Recorded in the
// tenant's own audit trail too, so the workspace can see which workers were opened to it and by whom.
export async function grant(db: Db, actor: string, tenantId: unknown, name: unknown, now = nowS()): Promise<{ created: boolean }> {
  await checkActor(db, actor, 'grant')
  const base = { actor, action: 'grant', name }
  if (typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId) || !okName(name)) return refuse(db, base, 'bad_request')
  if (!await db.get("SELECT 1 FROM worker_catalog WHERE name = ?", [name])) return refuse(db, base, 'unknown')
  const exists = await db.get('SELECT 1 AS x FROM organizations WHERE id = ? UNION SELECT 1 AS x FROM users WHERE id = ?', [tenantId, tenantId])
  const deleted = await db.get('SELECT 1 AS x FROM tenant_tombstones WHERE deleted_tenant = ?', [tenantId])
  if (!exists || deleted) return refuse(db, base, 'no_tenant')
  return db.tx(function* (t) {
    const r = yield* t.run('INSERT INTO worker_grants (tenant_id, name, granted_by, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, name) DO NOTHING', [tenantId, name, actor, now])
    if (r.changes === 1) {
      yield* recordTx(t, { tenantId, actorId: actor, actorKind: 'support', action: 'worker.grant', resourceType: 'worker', resourceId: name }, now)
      yield* eventIn(t, base, now)
    }
    return { created: r.changes === 1 }
  })
}

export async function revoke(db: Db, actor: string, tenantId: unknown, name: unknown, now = nowS()): Promise<{ removed: boolean }> {
  await checkActor(db, actor, 'revoke')
  const base = { actor, action: 'revoke', name }
  if (typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId) || !okName(name)) return refuse(db, base, 'bad_request')
  return db.tx(function* (t) {
    const r = yield* t.run('DELETE FROM worker_grants WHERE tenant_id = ? AND name = ?', [tenantId, name])
    if (r.changes === 1) {
      yield* recordTx(t, { tenantId, actorId: actor, actorKind: 'support', action: 'worker.revoke', resourceType: 'worker', resourceId: name }, now)
      yield* eventIn(t, base, now)
    }
    return { removed: r.changes === 1 }
  })
}

export async function granted(db: Db, tenantId: string, name: string): Promise<boolean> {
  return !!(await db.get('SELECT 1 AS x FROM worker_grants WHERE tenant_id = ? AND name = ?', [tenantId, name]))
}

export async function events(db: Db, opts: { name?: string; limit?: number } = {}): Promise<{ at: number; actor: string; action: string; decision: string; name: string | null; version: string | null; code_hash: string | null; generation: number | null; detail: string | null }[]> {
  const rows = await db.all<{ at: number; actor: string; action: string; decision: string; name: string | null; version: string | null; code_hash: string | null; generation: number | null; detail: string | null }>(
    `SELECT at, actor, action, decision, name, version, code_hash, generation, detail FROM worker_events${opts.name ? ' WHERE name = ?' : ''} ORDER BY id LIMIT ?`,
    [...(opts.name ? [opts.name] : []), Math.max(1, Math.min(1000, opts.limit ?? 200))])
  return rows.map(r => ({ ...r, at: Number(r.at), generation: n(r.generation) }))
}

export { catalogEntry, type CatRow }
