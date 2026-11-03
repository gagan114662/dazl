// The queue contract (types.ts) on the Db layer, so it runs on SQLite or Postgres. With DATABASE_URL set, any number
// of app instances share one queue: an item is claimed by exactly one of them, and an instance that dies holding a
// claim loses it when the lease runs out (back to pending with backoff, or failed past maxAttempts).
//
// How a claim stays exclusive across instances:
//   - Every claim transaction first takes the next fencing token with UPDATE work_queue_meta ... RETURNING. On Postgres
//     that row lock is held to commit, so claims are serialized across instances: the in-flight caps (per tenant and
//     global) are counted against committed claims, never against a racing claimer's stale view. On SQLite the
//     transaction is IMMEDIATE (one writer).
//   - The candidate row is then selected FOR UPDATE SKIP LOCKED (Postgres) and updated in the same transaction.
//   - complete/fail/reap match on (id, status 'claimed', claim_token): a stale token changes nothing ('stale').
// Fair service (#355): a claim can be scoped to a lane (its caps count only that lane's kinds) and ordered round-robin
// across tenants (work_queue_meta 't:<tenant>' holds the token of the tenant's last claim). Admission: enqueue can
// refuse a tenant whose active backlog of a kind is full, serialized per tenant and kind ('a:<tenant>:<kind>').
// Dead letters: failed items stay until replay() puts one back (attempts reset) or retire() removes it.
// Domain fencing stays the worker's job (types.ts): a worker that writes domain rows keeps its own ownership check.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { backoffSeconds, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.ts'
import {
  DEFAULT_LEASE_S, DEFAULT_MAX_ATTEMPTS,
  type Claim, type ClaimOptions, type EnqueueInput, type EnqueueResult, type FailOptions, type FailOutcome, type WorkItem,
  type QueueKindStats,
} from './types.ts'

const MAX_ERROR = 200

interface Row {
  id: string; tenant_id: string; kind: string; status: string
  attempts: number; max_attempts: number; not_before: number; created_at: number
  claimed_at: number | null; lease_expires_at: number | null
  claim_token: number | null; last_error: string | null
}

const num = (v: number | string | null) => v === null ? null : Number(v)
function toItem(r: Row): WorkItem {
  return {
    id: r.id, tenantId: r.tenant_id, kind: r.kind, status: r.status as WorkItem['status'],
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), notBefore: Number(r.not_before),
    createdAt: Number(r.created_at), claimedAt: num(r.claimed_at), leaseExpiresAt: num(r.lease_expires_at),
    claimToken: num(r.claim_token), lastError: r.last_error,
  }
}

const nowS = () => Math.floor(Date.now() / 1000)

function* release(t: Tx, id: string, token: number, to: 'pending' | 'done' | 'failed', error: string | null, notBefore?: number): TxBody<boolean> {
  // Terminal states clear dedupe_key so recurring work can be enqueued again.
  const r = yield* t.run(
    `UPDATE work_queue SET status = ?, last_error = ?, not_before = COALESCE(?, not_before), claimed_at = NULL, lease_expires_at = NULL,
       claim_token = NULL, dedupe_key = CASE WHEN ? IN ('done', 'failed') THEN NULL ELSE dedupe_key END
     WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
    [to, error, notBefore ?? null, to, id, token])
  return r.changes === 1
}

// Expired claims (an instance that died, hung or lost its connection): back to pending with backoff, or failed
// ('timeout') past maxAttempts. Runs inside every claim too.
function* reapIn(t: Tx, now: number, backoff: BackoffPolicy, rng: () => number): TxBody<number> {
  const rows = yield* t.all<Row>("SELECT * FROM work_queue WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?", [now])
  let n = 0
  for (const r of rows) {
    const attempts = Number(r.attempts)
    const ok = attempts >= Number(r.max_attempts)
      ? yield* release(t, r.id, Number(r.claim_token), 'failed', 'timeout')
      : yield* release(t, r.id, Number(r.claim_token), 'pending', r.last_error, now + backoffSeconds(attempts, backoff, rng))
    if (ok) n++
  }
  return n
}


export class DbQueue {
  private db: Db
  private backoff: BackoffPolicy
  private rng: () => number

  constructor(db: Db, opts?: { backoff?: Partial<BackoffPolicy>; rng?: () => number }) {
    this.db = db
    this.backoff = { ...DEFAULT_BACKOFF, ...opts?.backoff }
    this.rng = opts?.rng ?? Math.random
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const now = input.now ?? nowS()
    const id = input.id ?? randomBytes(8).toString('hex')
    const insert = 'INSERT INTO work_queue (id, tenant_id, kind, status, attempts, max_attempts, not_before, created_at, dedupe_key) VALUES (?, ?, ?, \'pending\', 0, ?, ?, ?, ?)'
    const args = [id, input.tenantId, input.kind, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, input.notBefore ?? now, now, input.dedupeKey ?? null]
    const backlog = input.maxBacklog
    if (backlog !== undefined && !(Number.isInteger(backlog) && backlog >= 0)) throw new Error('maxBacklog must be a non-negative integer')
    if (!input.dedupeKey && backlog === undefined) { await this.db.run(insert, args); return { id, created: true } }
    // The partial unique index (active items only) is the dedupe check: the INSERT itself decides, no check-then-insert
    // window. A duplicate id still throws (primary key), as in the SQLite adapter.
    return this.db.tx(function* (t): TxBody<EnqueueResult> {
      const active = (): TxBody<{ id: string } | undefined> => t.get<{ id: string }>("SELECT id FROM work_queue WHERE tenant_id = ? AND kind = ? AND dedupe_key = ? AND status IN ('pending','claimed')", [input.tenantId, input.kind, input.dedupeKey!])
      if (backlog !== undefined) {
        // One admission at a time per tenant and kind: the counter row is locked to commit on Postgres.
        yield* t.run('INSERT INTO work_queue_meta (k, v) VALUES (?, 0) ON CONFLICT (k) DO UPDATE SET v = work_queue_meta.v + 1', [`a:${input.tenantId}:${input.kind}`])
        if (input.dedupeKey) { const w = yield* active(); if (w) return { id: w.id, created: false } }
        const n = Number((yield* t.get<{ c: number }>("SELECT count(*) AS c FROM work_queue WHERE tenant_id = ? AND kind = ? AND status IN ('pending','claimed')", [input.tenantId, input.kind]))!.c)
        if (n >= backlog) return { id: '', created: false, refused: 'backlog' }
      }
      if (!input.dedupeKey) { yield* t.run(insert, args); return { id, created: true } }
      const r = yield* t.run(`${insert} ON CONFLICT (tenant_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed') DO NOTHING`, args)
      if (r.changes === 1) return { id, created: true }
      return { id: (yield* active())!.id, created: false }
    })
  }

  async claim(opts?: ClaimOptions): Promise<Claim | null> {
    const now = opts?.now ?? nowS()
    const perTenant = opts?.perTenantInFlight ?? 1
    const maxInFlight = opts?.maxInFlight ?? 3
    const lease = opts?.leaseSeconds ?? DEFAULT_LEASE_S
    if (opts?.kinds && opts.kinds.length === 0) return null // fail closed, as the other adapters
    if (opts?.tenants && opts.tenants.length === 0) return null
    if (opts?.lane && !opts.kinds?.length) throw new Error('a lane claim needs kinds')
    const pg = this.db.kind === 'pg'
    const kindList = opts?.kinds ?? []
    const laneSql = (alias: string) => opts?.lane ? ` AND ${alias}kind IN (${kindList.map(() => '?').join(', ')})` : ''
    const laneArgs = opts?.lane ? kindList : []
    const rr = opts?.order === 'round_robin'
    const { backoff, rng } = this
    return this.db.tx(function* (t): TxBody<Claim | null> {
      // Serializes claims across instances on Postgres (row lock to commit); the token is unique and never reused.
      yield* t.run("INSERT INTO work_queue_meta (k, v) VALUES ('token', 0) ON CONFLICT (k) DO NOTHING")
      const token = Number((yield* t.get<{ v: number }>("UPDATE work_queue_meta SET v = v + 1 WHERE k = 'token' RETURNING v"))!.v)
      yield* reapIn(t, now, backoff, rng)
      const inFlight = Number((yield* t.get<{ c: number }>(`SELECT count(*) AS c FROM work_queue WHERE status = 'claimed'${laneSql('')}`, laneArgs))!.c)
      if (inFlight >= maxInFlight) return null
      const kinds = opts?.kinds?.length ? `AND w.kind IN (${opts.kinds.map(() => '?').join(', ')})` : ''
      const tenants = opts?.tenants?.length ? `AND w.tenant_id IN (${opts.tenants.map(() => '?').join(', ')})` : ''
      // FIFO: the oldest claimable item whose tenant is under its in-flight cap (head-of-line across tenants).
      // Round-robin: the tenant whose last claim is oldest (never claimed = 0) first, then its oldest item.
      const row = yield* t.get<Row>(
        `SELECT w.* FROM work_queue w${rr ? " LEFT JOIN work_queue_meta m ON m.k = 't:' || w.tenant_id" : ''}
         WHERE w.status = 'pending' AND w.not_before <= ? ${kinds} ${tenants}
           AND (SELECT count(*) FROM work_queue c WHERE c.status = 'claimed' AND c.tenant_id = w.tenant_id${laneSql('c.')}) < ?
         ORDER BY ${rr ? 'COALESCE(m.v, 0), ' : ''}w.created_at, w.id LIMIT 1${pg ? ' FOR UPDATE OF w SKIP LOCKED' : ''}`,
        [now, ...(opts?.kinds ?? []), ...(opts?.tenants ?? []), ...laneArgs, perTenant])
      if (!row) return null
      yield* t.run('INSERT INTO work_queue_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [`t:${row.tenant_id}`, token])
      const claimed = yield* t.get<Row>(
        "UPDATE work_queue SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, lease_expires_at = ?, claim_token = ? WHERE id = ? AND status = 'pending' RETURNING *",
        [now, now + lease, token, row.id])
      return claimed ? { item: toItem(claimed), token, leaseExpiresAt: now + lease } : null
    })
  }

  async complete(token: number): Promise<boolean> {
    return this.db.tx(function* (t): TxBody<boolean> {
      const r = yield* t.get<Row>("SELECT * FROM work_queue WHERE claim_token = ? AND status = 'claimed'", [token])
      return r ? yield* release(t, r.id, token, 'done', null) : false
    })
  }

  async fail(token: number, opts?: FailOptions): Promise<FailOutcome> {
    const now = opts?.now ?? nowS()
    const { backoff, rng } = this
    return this.db.tx(function* (t): TxBody<FailOutcome> {
      const r = yield* t.get<Row>("SELECT * FROM work_queue WHERE claim_token = ? AND status = 'claimed'", [token])
      if (!r) return 'stale'
      const error = (opts?.error ?? 'failed').slice(0, MAX_ERROR)
      const attempts = Number(r.attempts)
      if (opts?.retryable === false || attempts >= Number(r.max_attempts)) return (yield* release(t, r.id, token, 'failed', error)) ? 'failed' : 'stale'
      return (yield* release(t, r.id, token, 'pending', error, now + backoffSeconds(attempts, backoff, rng))) ? 'retry' : 'stale'
    })
  }

  async reapExpired(now?: number): Promise<number> {
    const { backoff, rng } = this
    return this.db.tx(function* (t) { return yield* reapIn(t, now ?? nowS(), backoff, rng) })
  }

  // Remove a terminal (done/failed) item so the same id can be enqueued again (a new scheduling epoch). Fencing tokens
  // come from work_queue_meta, so a retired item's tokens stay dead.
  async retire(id: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM work_queue WHERE id = ? AND status IN ('done', 'failed')", [id])).changes === 1
  }

  // Dead-letter replay: a failed item goes back to pending with its attempts reset, claimable from `now`. Nothing else
  // moves, so a done item, an active one or an unknown id is refused (false). The worker's own domain fencing still
  // decides what the replayed run may write.
  async replay(id: string, now?: number): Promise<boolean> {
    return (await this.db.run("UPDATE work_queue SET status = 'pending', attempts = 0, not_before = ?, last_error = NULL WHERE id = ? AND status = 'failed'", [now ?? nowS(), id])).changes === 1
  }

  async failed(opts?: { kind?: string; limit?: number }): Promise<WorkItem[]> {
    const rows = await this.db.all<Row>(`SELECT * FROM work_queue WHERE status = 'failed'${opts?.kind ? ' AND kind = ?' : ''} ORDER BY created_at DESC, id LIMIT ?`,
      [...(opts?.kind ? [opts.kind] : []), Math.max(1, Math.min(500, opts?.limit ?? 100))])
    return rows.map(toItem)
  }

  // Per-kind depth, dead letters, oldest wait and expired claims: what the queue alerts read (lib/queue/alerts.ts).
  // Counts only; no tenant ids or payloads.
  async stats(now?: number): Promise<QueueKindStats[]> {
    const t = now ?? nowS()
    const rows = await this.db.all<{ kind: string; pending: number; claimed: number; failed: number; oldest: number | null; expired: number }>(
      `SELECT kind,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              MIN(CASE WHEN status = 'pending' AND not_before <= ? THEN not_before END) AS oldest,
              SUM(CASE WHEN status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS expired
       FROM work_queue GROUP BY kind ORDER BY kind`, [t, t])
    return rows.map(r => ({ kind: r.kind, pending: Number(r.pending), claimed: Number(r.claimed), failed: Number(r.failed), oldestPendingAgeS: r.oldest === null ? 0 : Math.max(0, t - Number(r.oldest)), expiredClaims: Number(r.expired) }))
  }

  async get(id: string): Promise<WorkItem | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM work_queue WHERE id = ?', [id])
    return r ? toItem(r) : undefined
  }

  async depth(opts?: { tenantId?: string; kind?: string; status?: WorkItem['status'] }): Promise<number> {
    const cond: string[] = [], args: string[] = []
    if (opts?.tenantId) { cond.push('tenant_id = ?'); args.push(opts.tenantId) }
    if (opts?.kind) { cond.push('kind = ?'); args.push(opts.kind) }
    if (opts?.status) { cond.push('status = ?'); args.push(opts.status) }
    return Number((await this.db.get<{ c: number }>(`SELECT count(*) AS c FROM work_queue ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}`, args))!.c)
  }
}
