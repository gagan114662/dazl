// Running reviewed workers (docs/design/runtime-workers.md): the tenant-side enqueue and read, and the worker host
// that any number of processes can run against one database.
//
// Delivery is at least once. What keeps a repeat or a late finish harmless:
//   - the queue's claim token (lib/queue/db.ts): a claim reaped after its lease, or fenced by stop/restart/rollback,
//     no longer owns its item, and its finish changes nothing;
//   - the deployment generation: a finish commits only if the worker's version and generation are still the ones the
//     claim ran under; otherwise the item goes back to pending and the result is dropped;
//   - one transaction: the run's output and the queue transition commit together, or neither does.
// Limits are read from worker_deployments on every claim and counted against committed claims in the shared queue, so
// they hold across every process (global in-flight per worker, per-tenant in-flight, per-tenant backlog), not per host.
// Only none/draft workers run here (definition.ts RUNNABLE_EFFECTS); nothing in this file sends, spends or calls out.
import { randomBytes } from 'node:crypto'
import type { Db, TxBody } from '../db/client.ts'
import { captureError } from '../ops/errors.ts'
import { backoffSeconds, DEFAULT_BACKOFF, type BackoffPolicy } from '../queue/backoff.ts'
import { DbQueue, requeueIn, settleIn } from '../queue/db.ts'
import type { Claim } from '../queue/types.ts'
import { can, type Role } from '../workspaces.ts'
import { fileHash, key, NAME_RE, unrunnable, type Registry, type RegistryEntry, type WorkerDefinition } from './definition.ts'
import { parseChecked, validate } from './schema.ts'
import {
  catalogEntry, deployment, deployments, event, eventIn, granted, kindOf, settle, storedDefinition, toDeployment, transitionIn,
  type Deployment,
} from './store.ts'

const nowS = () => Math.floor(Date.now() / 1000)

// ---- tenant side ----

// The caller's identity comes from its session (lib/auth-db.ts SessionUser): the tenant is never a parameter.
export type RunUser = { tenantId: string; actorId: string; role: Role }
export type EnqueueOutcome = { ok: true; id: string } | { ok: false; error: 'forbidden' | 'unavailable' | 'bad_input' | 'backlog'; detail?: string }

// Queue one run of `name` for the session's tenant. 'unavailable' covers an unknown worker, one not running, one not
// granted to this tenant and one whose stored definition can no longer run, alike, so the answer says nothing about
// the catalog. None of those writes anything: until an operator has registered, started and granted the worker, a
// tenant request leaves no row anywhere. Only a running, granted worker's refusals (bad_input, backlog) are recorded, as
// 'refused' runs in the tenant's own runs (input never stored, a fixed error code).
const unavailable = (): EnqueueOutcome => ({ ok: false, error: 'unavailable' })
export async function enqueueRun(db: Db, user: RunUser, name: unknown, input: unknown, now = nowS()): Promise<EnqueueOutcome> {
  if (!can(user.role, 'operate')) return { ok: false, error: 'forbidden' }
  if (typeof name !== 'string' || !NAME_RE.test(name)) return unavailable()
  const d = await deployment(db, name)
  if (!d || d.state !== 'running' || !await granted(db, user.tenantId, name)) return unavailable()
  const cat = await catalogEntry(db, name, d.version)
  const def = cat && storedDefinition(cat)
  if (!def || unrunnable(def)) return unavailable()
  const id = randomBytes(12).toString('hex')
  const refuse = async (error: 'bad_input', detail: string): Promise<EnqueueOutcome> => {
    await db.run("INSERT INTO worker_runs (id, tenant_id, name, actor_id, status, input, error, created_at, finished_at) VALUES (?, ?, ?, ?, 'refused', 'null', ?, ?, ?)",
      [id, user.tenantId, name, user.actorId.slice(0, 80), `${error}: ${detail}`.slice(0, 200), now, now])
    return { ok: false, error, detail }
  }
  const bad = validate(def.input, input)
  if (bad) return refuse('bad_input', bad)
  const text = JSON.stringify(input)
  if (Buffer.byteLength(text, 'utf8') > def.maxInputBytes) return refuse('bad_input', 'too large')
  await db.run("INSERT INTO worker_runs (id, tenant_id, name, actor_id, status, input, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
    [id, user.tenantId, name, user.actorId.slice(0, 80), text, now])
  let r
  try {
    r = await new DbQueue(db).enqueue({ id, tenantId: user.tenantId, kind: kindOf(name), maxBacklog: d.maxBacklog, maxAttempts: d.maxAttempts, now })
  } catch (e) {
    await db.run("UPDATE worker_runs SET status = 'refused', error = 'enqueue_failed', finished_at = ? WHERE id = ? AND status = 'queued'", [now, id])
    throw e
  }
  if (r.refused) {
    await db.run("UPDATE worker_runs SET status = 'refused', error = 'backlog', finished_at = ? WHERE id = ? AND status = 'queued'", [now, id])
    return { ok: false, error: 'backlog' }
  }
  return { ok: true, id }
}

export type RunView = { id: string; name: string; status: string; version: string | null; output: unknown; error: string | null; createdAt: number; finishedAt: number | null }
type RunRow = { id: string; tenant_id: string; name: string; status: string; input: string; version: string | null; generation: number | null; output: string | null; error: string | null; created_at: number; finished_at: number | null }

// One of the session tenant's own runs; another tenant's id reads as not found.
export async function getRun(db: Db, user: RunUser, id: unknown): Promise<RunView | null> {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return null
  const r = await db.get<RunRow>('SELECT * FROM worker_runs WHERE id = ? AND tenant_id = ?', [id, user.tenantId])
  return r ? view(r) : null
}

// The session tenant's most recent runs, newest first.
export async function listRuns(db: Db, user: { tenantId: string }, limit = 50): Promise<RunView[]> {
  const rows = await db.all<RunRow>('SELECT * FROM worker_runs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [user.tenantId, Math.max(1, Math.min(200, limit))])
  return rows.map(view)
}

function view(r: RunRow): RunView {
  let output: unknown = null
  if (r.output !== null) { try { output = JSON.parse(r.output) } catch { output = null } }
  return { id: r.id, name: r.name, status: r.status, version: r.version, output, error: r.error, createdAt: Number(r.created_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at) }
}

// ---- worker host ----

// A worker whose handler fails this many times in a row is stopped as crash-looping ('failed'); hosts restart it after
// a backoff, at most MAX_AUTO_RESTARTS times, then it stays failed until an operator restarts it.
export const CRASH_LOOP_FAILURES = 5
export const MAX_AUTO_RESTARTS = 3
// A claim's lease outlives the handler's own timeout by this much, so a live handler is never reaped mid-run.
export const LEASE_MARGIN_S = 2

export interface Claimed { claim: Claim; dep: Deployment; def: WorkerDefinition; entry: RegistryEntry }
export type Result = { ok: true; output: string } | { ok: false; error: string; retryable: boolean; fault: boolean }
export type Finish = 'done' | 'retry' | 'failed' | 'stale'

class HandlerTimeout extends Error {}

export interface HostOptions {
  registry: Registry
  // Names this host in worker_events (host:<instance>).
  instance: string
  backoff?: Partial<BackoffPolicy>
  rng?: () => number
  clock?: () => number
}

export class WorkerHost {
  private db: Db
  private q: DbQueue
  private registry: Registry
  private actor: string
  private backoff: BackoffPolicy
  private rng: () => number
  private clock: () => number
  private refused = new Set<string>()
  private turn = 0

  constructor(db: Db, opts: HostOptions) {
    this.db = db
    this.registry = opts.registry
    this.actor = `host:${opts.instance}`.slice(0, 80)
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
    this.rng = opts.rng ?? Math.random
    this.clock = opts.clock ?? nowS
    this.q = new DbQueue(db, { backoff: this.backoff, rng: this.rng })
  }

  // Housekeeping every host does on each tick: finish drains, and restart crash-looped workers whose backoff is over.
  async maintain(): Promise<void> {
    const now = this.clock()
    for (const d of await deployments(this.db)) {
      if (d.state === 'draining') await settle(this.db, d.name, now)
      else if (d.state === 'failed' && d.restartAfter !== null && d.restartAfter <= now) {
        const cat = await catalogEntry(this.db, d.name, d.version)
        const def = cat && storedDefinition(cat)
        if (!def || unrunnable(def)) continue
        await this.db.tx(function* (t): TxBody<void> {
          const r = yield* transitionIn(t, d.name, { state: 'running', reason: `auto restart ${d.restarts + 1}/${MAX_AUTO_RESTARTS}`, resetCounters: true, restarts: d.restarts + 1, ifGeneration: d.generation }, 'system', now)
          if (r) yield* eventIn(t, { actor: 'system', action: 'auto_restart', name: d.name, version: d.version, codeHash: cat.code_hash, generation: r.generation, detail: `restart ${r.restarts}/${MAX_AUTO_RESTARTS}` }, now)
        })
      }
    }
  }

  // Can this host run this deployment? Its (name, version) must be in this build's reviewed registry, the registered
  // hash must equal the pinned one and the file on disk, and the stored definition must still be runnable. A refusal
  // is recorded once per host and generation, and the worker is skipped (another host with the right build may run it).
  private async verified(d: Deployment): Promise<{ def: WorkerDefinition; entry: RegistryEntry } | null> {
    const entry = this.registry.get(key(d.name, d.version))
    const cat = await catalogEntry(this.db, d.name, d.version)
    const def = cat && storedDefinition(cat)
    let why: string | null = null
    if (!entry) why = 'not in this build'
    else if (!cat || !def) why = 'catalog entry unreadable'
    else if (cat.code_hash !== entry.sha256 || fileHash(entry) !== cat.code_hash) why = 'hash_mismatch'
    else why = unrunnable(def)
    if (!why) return { def: def!, entry: entry! }
    const k = `${d.name}@${d.version}#${d.generation}`
    if (!this.refused.has(k)) {
      this.refused.add(k)
      await event(this.db, { actor: this.actor, action: 'host_refused', decision: 'denied', name: d.name, version: d.version, codeHash: cat?.code_hash, generation: d.generation, detail: why })
    }
    return null
  }

  // Claim the next item of any running worker this host can run, rotating which worker is tried first.
  async claimNext(): Promise<Claimed | null> {
    const running = (await deployments(this.db)).filter(d => d.state === 'running')
    const start = this.turn++
    for (let i = 0; i < running.length; i++) {
      const d = running[(start + i) % running.length]
      const v = await this.verified(d)
      if (!v) continue
      const claim = await this.q.claim({
        kinds: [kindOf(d.name)], lane: true, maxInFlight: d.maxInFlight, perTenantInFlight: d.perTenantInFlight,
        leaseSeconds: Math.ceil(v.def.timeoutMs / 1000) + LEASE_MARGIN_S, order: 'round_robin', now: this.clock(),
      })
      if (claim) return { claim, dep: d, ...v }
    }
    return null
  }

  // Run the claimed item's handler. Never throws for anything the handler or its input does.
  async execute(c: Claimed): Promise<Result> {
    const r = await this.db.get<RunRow>('SELECT * FROM worker_runs WHERE id = ?', [c.claim.item.id])
    if (!r || r.tenant_id !== c.claim.item.tenantId || r.name !== c.dep.name || r.status !== 'queued') return { ok: false, error: 'orphan', retryable: false, fault: false }
    const input = parseChecked(c.def.input, r.input, c.def.maxInputBytes)
    if (!input.ok) return { ok: false, error: `input_schema: ${input.error}`, retryable: false, fault: false }
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let out: unknown
    try {
      out = await Promise.race([
        Promise.resolve().then(() => c.entry.module.run(input.value, Object.freeze({ tenantId: r.tenant_id, signal: ac.signal }))),
        new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new HandlerTimeout()) }, c.def.timeoutMs) }),
      ])
    } catch (e) {
      // the thrown value is never stringified: it may be anything, including tenant input or a throwing toString
      return { ok: false, error: e instanceof HandlerTimeout ? 'timeout' : 'handler_error', retryable: true, fault: true }
    } finally { clearTimeout(timer) }
    const bad = validate(c.def.output, out)
    if (bad) return { ok: false, error: `output_schema: ${bad}`, retryable: false, fault: true }
    const text = JSON.stringify(out)
    if (Buffer.byteLength(text, 'utf8') > c.def.maxOutputBytes) return { ok: false, error: 'output_too_large', retryable: false, fault: true }
    return { ok: true, output: text }
  }

  // Commit a result, only if this claim still owns the item AND the worker is still at the version and generation the
  // claim ran under. Otherwise nothing of the result is written ('stale'); a fenced claim's item goes back to pending.
  async finish(c: Claimed, res: Result): Promise<Finish> {
    const now = this.clock()
    const { backoff, rng } = this
    const token = c.claim.token, id = c.claim.item.id, name = c.dep.name
    const out = await this.db.tx(function* (t): TxBody<Finish> {
      const row = yield* t.get<Parameters<typeof toDeployment>[0]>('SELECT * FROM worker_deployments WHERE name = ?', [name])
      const d = row ? toDeployment(row) : null
      if (!d || d.generation !== c.dep.generation || d.version !== c.dep.version || (d.state !== 'running' && d.state !== 'draining')) {
        yield* requeueIn(t, token, now)
        return 'stale'
      }
      const outcome = yield* settleIn(t, token, res.ok ? { ok: true } : { ok: false, error: res.error, retryable: res.retryable }, now, backoff, rng)
      if (outcome === 'stale') return 'stale'
      if (outcome === 'done' && res.ok) {
        yield* t.run("UPDATE worker_runs SET status = 'done', output = ?, error = NULL, version = ?, generation = ?, finished_at = ? WHERE id = ? AND status = 'queued'",
          [res.output, d.version, d.generation, now, id])
      } else if (!res.ok) {
        yield* t.run(`UPDATE worker_runs SET status = ?, error = ?, version = ?, generation = ?, finished_at = ? WHERE id = ? AND status = 'queued'`,
          [outcome === 'failed' ? 'failed' : 'queued', res.error.slice(0, 200), d.version, d.generation, outcome === 'failed' ? now : null, id])
      }
      if (res.ok) {
        if (d.failures) yield* t.run('UPDATE worker_deployments SET failures = 0 WHERE name = ? AND generation = ?', [name, d.generation])
      } else if (!res.ok && res.fault) {
        if (d.failures + 1 < CRASH_LOOP_FAILURES) yield* t.run('UPDATE worker_deployments SET failures = failures + 1 WHERE name = ? AND generation = ?', [name, d.generation])
        else {
          const again = d.restarts < MAX_AUTO_RESTARTS
          const r = yield* transitionIn(t, name, { state: 'failed', reason: again ? 'crash_loop' : 'crash_loop: automatic restarts used up', restartAfter: again ? now + backoffSeconds(d.restarts + 1, backoff, rng) : null, ifGeneration: d.generation }, 'system', now)
          if (r) yield* eventIn(t, { actor: 'system', action: 'crash_loop', decision: 'allowed', name, version: d.version, generation: r.generation, detail: `failures=${d.failures + 1} restarts=${d.restarts}` }, now)
        }
      }
      return outcome
    })
    if (out === 'stale') {
      try { await event(this.db, { actor: this.actor, action: 'complete_stale', decision: 'denied', name, version: c.dep.version, generation: c.dep.generation, detail: res.ok ? 'result dropped' : `error dropped: ${res.error}` }) }
      catch (e) { captureError(e, { source: 'worker', where: 'workers:stale-event' }) }
    }
    return out
  }

  // One step: housekeeping, then claim, run and finish at most one item. null when there was nothing to run.
  async tick(): Promise<Finish | null> {
    await this.maintain()
    const c = await this.claimNext()
    if (!c) return null
    return this.finish(c, await this.execute(c))
  }
}

// A host loop: `concurrency` tickers until `signal` aborts. An error escaping a tick (a database fault) is reported and
// the loop backs off; the claim it held, if any, is recovered by its lease.
// Each sleep removes its own abort listener whichever way it ends (timer or abort), so a long idle host holds at most
// one listener per ticker, not one per completed sleep (#918). An already-aborted signal returns at once.
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve() }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function runHost(host: Pick<WorkerHost, 'tick'>, opts: { concurrency?: number; idleMs?: number; signal: AbortSignal }): Promise<void> {
  const sleep = (ms: number) => abortableSleep(ms, opts.signal)
  const loop = async () => {
    while (!opts.signal.aborted) {
      try {
        if ((await host.tick()) === null) await sleep(opts.idleMs ?? 500)
      } catch (e) {
        captureError(e, { source: 'worker', where: 'workers:host' })
        await sleep(opts.idleMs ?? 500)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(16, opts.concurrency ?? 2)) }, loop))
}
