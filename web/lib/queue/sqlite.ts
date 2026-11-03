// Durable SQLite QueueAdapter: same contract and semantics as InProcessQueue
// (memory.ts), but state survives process restart, so wiring work does not
// wait on the Postgres migration. Uses the app's existing better-sqlite3.
//
// Schema is adapter-owned (CREATE TABLE IF NOT EXISTS) so this slice adds no
// migration and touches no existing table; a production wiring PR moves the
// table into the migration runner and the pg-migrate schema extract.
//
// Fencing/durability notes:
//   - claimToken comes from a monotonic side table (queue_meta), never reset
//     by restart - a token handed out before a crash stays stale forever.
//   - claim() runs in an IMMEDIATE transaction: SELECT head-of-line + UPDATE
//     are atomic, so two processes cannot claim the same row.
//   - Domain fencing is unchanged queue-external: workers must keep their
//     domain-level ownership checks (e.g. scan_jobs.attempts) - see types.ts.
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { backoffSeconds, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.ts'
import {
  DEFAULT_LEASE_S, DEFAULT_MAX_ATTEMPTS,
  type Claim, type ClaimOptions, type EnqueueInput, type EnqueueResult,
  type FailOptions, type FailOutcome, type QueueAdapter, type WorkItem,
} from './types.ts'

const MAX_ERROR = 200 // parity with scan_jobs.error cap

interface Row {
  id: string; tenant_id: string; kind: string; status: string
  attempts: number; max_attempts: number; not_before: number; created_at: number
  claimed_at: number | null; lease_expires_at: number | null
  claim_token: number | null; last_error: string | null; dedupe_key: string | null
}

function toItem(r: Row): WorkItem {
  return {
    id: r.id, tenantId: r.tenant_id, kind: r.kind, status: r.status as WorkItem['status'],
    attempts: r.attempts, maxAttempts: r.max_attempts, notBefore: r.not_before,
    createdAt: r.created_at, claimedAt: r.claimed_at, leaseExpiresAt: r.lease_expires_at,
    claimToken: r.claim_token, lastError: r.last_error,
  }
}

export class SqliteQueue implements QueueAdapter {
  private db: Database.Database
  private backoff: BackoffPolicy
  private rng: () => number

  constructor(db: Database.Database, opts?: { backoff?: Partial<BackoffPolicy>; rng?: () => number }) {
    this.db = db
    this.backoff = { ...DEFAULT_BACKOFF, ...opts?.backoff }
    this.rng = opts?.rng ?? Math.random
    // NOTE: no journal_mode pragma here - mutating a shared handle from a
    // constructor is surprising. The app's DB handles already run WAL
    // (lib/auth-db.ts); a caller supplying its own handle owns its pragmas.
    db.exec(`CREATE TABLE IF NOT EXISTS work_queue (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        not_before INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        lease_expires_at INTEGER,
        claim_token INTEGER,
        last_error TEXT,
        dedupe_key TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS work_queue_dedupe
        ON work_queue(tenant_id, kind, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed');
      CREATE INDEX IF NOT EXISTS work_queue_claimable
        ON work_queue(status, not_before, created_at);
      CREATE TABLE IF NOT EXISTS work_queue_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      INSERT OR IGNORE INTO work_queue_meta(k, v) VALUES ('token', 0);`)
  }

  private nextToken(): number {
    this.db.prepare(`UPDATE work_queue_meta SET v = v + 1 WHERE k = 'token'`).run()
    return (this.db.prepare(`SELECT v FROM work_queue_meta WHERE k = 'token'`).get() as { v: number }).v
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    if (input.maxBacklog !== undefined) throw new Error('maxBacklog admission is DbQueue only')
    const now = input.now ?? Math.floor(Date.now() / 1000)
    // No SELECT-first: the INSERT itself is the atomic dedupe check (partial
    // unique index), so the check-then-insert race window does not exist.
    const id = input.id ?? randomBytes(8).toString('hex')
    try {
      this.db.prepare(`INSERT INTO work_queue
          (id, tenant_id, kind, status, attempts, max_attempts, not_before, created_at, dedupe_key)
          VALUES (?,?,?,?,0,?,?,?,?)`)
        .run(id, input.tenantId, input.kind, 'pending',
          input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, input.notBefore ?? now, now, input.dedupeKey ?? null)
    } catch (e) {
      const msg = (e as Error).message
      // Another writer won the dedupe race between our SELECT and INSERT:
      // the contract says an active duplicate returns the existing item.
      if (input.dedupeKey && msg.includes('dedupe_key') && msg.includes('UNIQUE constraint failed')) {
        const winner = this.db
          .prepare(`SELECT id FROM work_queue WHERE tenant_id=? AND kind=? AND dedupe_key=? AND status IN ('pending','claimed')`)
          .get(input.tenantId, input.kind, input.dedupeKey) as { id: string } | undefined
        if (winner) return { id: winner.id, created: false }
        // Winner went terminal in between: safe to retry once as a fresh insert.
        this.db.prepare(`INSERT INTO work_queue
            (id, tenant_id, kind, status, attempts, max_attempts, not_before, created_at, dedupe_key)
            VALUES (?,?,?,?,0,?,?,?,?)`)
          .run(id, input.tenantId, input.kind, 'pending',
            input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, input.notBefore ?? now, now, input.dedupeKey ?? null)
      } else if (msg.includes('UNIQUE')) {
        throw new Error(`queue item id already exists: ${id}`)
      } else {
        throw e
      }
    }
    return { id, created: true }
  }

  private release(
    id: string,
    to: 'pending' | 'done' | 'failed',
    error: string | null,
    expect: { token: number },
    notBefore?: number,
  ): boolean {
    // Terminal release clears dedupe_key (recurring work may re-enqueue);
    // the unique index is partial on active statuses so this stays race-safe.
    // The WHERE clause pins status AND the captured claim token: if the row
    // was reaped and re-claimed since we read it, this updates 0 rows and the
    // caller must treat its action as stale.
    const ch = this.db.prepare(`UPDATE work_queue SET status=?, last_error=?,
        not_before = COALESCE(?, not_before),
        claimed_at=NULL, lease_expires_at=NULL, claim_token=NULL,
        dedupe_key = CASE WHEN ? IN ('done','failed') THEN NULL ELSE dedupe_key END
      WHERE id=? AND status='claimed' AND claim_token=?`)
      .run(to, error, notBefore ?? null, to, id, expect.token)
    return ch.changes === 1
  }

  claim(opts?: ClaimOptions): Claim | null {
    // Lanes and round-robin order are the shared adapter's (DbQueue); refuse rather than silently ignore them.
    if (opts?.lane || (opts?.order && opts.order !== 'fifo')) throw new Error('lane / round_robin claims are DbQueue only')
    const now = opts?.now ?? Math.floor(Date.now() / 1000)
    const perTenant = opts?.perTenantInFlight ?? 1
    const maxInFlight = opts?.maxInFlight ?? 3
    const lease = opts?.leaseSeconds ?? DEFAULT_LEASE_S
    return this.db.transaction((): Claim | null => {
      this.reapExpired(now)
      const inFlight = (this.db.prepare(`SELECT count(*) c FROM work_queue WHERE status='claimed'`).get() as { c: number }).c
      if (inFlight >= maxInFlight) return null
      // Inter-tenant head-of-line FIFO, same as InProcessQueue: pick the
      // oldest claimable item whose tenant is under its in-flight cap.
      // kinds:[] means "this worker executes nothing" (fail closed), matching
      // the memory adapter's empty-Set behavior - not "all kinds".
      if (opts?.kinds && opts.kinds.length === 0) return null
      if (opts?.tenants && opts.tenants.length === 0) return null
      const kindFilter = opts?.kinds?.length
        ? `AND kind IN (${opts.kinds.map(() => '?').join(',')})` : ''
      const tenantFilter = opts?.tenants?.length
        ? `AND tenant_id IN (${opts.tenants.map(() => '?').join(',')})` : ''
      const rows = this.db.prepare(
        `SELECT rowid AS rid, * FROM work_queue
         WHERE status='pending' AND not_before<=? ${kindFilter} ${tenantFilter}
         ORDER BY created_at ASC, rid ASC`).all(now, ...(opts?.kinds ?? []), ...(opts?.tenants ?? [])) as Row[]
      for (const r of rows) {
        const tenantInFlight = (this.db.prepare(
          `SELECT count(*) c FROM work_queue WHERE status='claimed' AND tenant_id=?`).get(r.tenant_id) as { c: number }).c
        if (tenantInFlight >= perTenant) continue
        const token = this.nextToken()
        this.db.prepare(`UPDATE work_queue SET status='claimed', attempts=attempts+1,
            claimed_at=?, lease_expires_at=?, claim_token=? WHERE id=?`)
          .run(now, now + lease, token, r.id)
        const item = this.get(r.id)!
        return { item, token, leaseExpiresAt: now + lease }
      }
      return null
    }).immediate()
  }

  private owned(token: number): Row | undefined {
    return this.db.prepare(`SELECT * FROM work_queue WHERE claim_token=? AND status='claimed'`).get(token) as Row | undefined
  }

  complete(token: number, opts?: { now?: number }): boolean {
    void opts
    const r = this.owned(token)
    if (!r) return false
    return this.release(r.id, 'done', null, { token })
  }

  fail(token: number, opts?: FailOptions): FailOutcome {
    const now = opts?.now ?? Math.floor(Date.now() / 1000)
    const retryable = opts?.retryable ?? true
    const r = this.owned(token)
    if (!r) return 'stale'
    const error = (opts?.error ?? 'failed').slice(0, MAX_ERROR)
    if (!retryable || r.attempts >= r.max_attempts) {
      return this.release(r.id, 'failed', error, { token }) ? 'failed' : 'stale'
    }
    return this.release(r.id, 'pending', error, { token }, now + backoffSeconds(r.attempts, this.backoff, this.rng))
      ? 'retry' : 'stale'
  }

  reapExpired(now?: number): number {
    const t = now ?? Math.floor(Date.now() / 1000)
    const rows = this.db.prepare(
      `SELECT * FROM work_queue WHERE status='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`).all(t) as Row[]
    let n = 0
    for (const r of rows) {
      // Conditional on the captured token: a re-claim between our SELECT and
      // this UPDATE makes it a 0-row no-op instead of clobbering the live claim.
      const ok = r.attempts >= r.max_attempts
        ? this.release(r.id, 'failed', 'timeout', { token: r.claim_token! })
        : this.release(r.id, 'pending', r.last_error, { token: r.claim_token! }, t + backoffSeconds(r.attempts, this.backoff, this.rng))
      if (ok) n++
    }
    return n
  }

  // Remove a terminal (done/failed) row so its domain id can be re-enqueued
  // for a new scheduling epoch. Refuses live rows. Tokens are never reused
  // (meta table), so a retired row's fencing history stays dead.
  retire(id: string): boolean {
    const ch = this.db.prepare(`DELETE FROM work_queue WHERE id=? AND status IN ('done','failed')`).run(id)
    return ch.changes === 1
  }

  get(id: string): WorkItem | undefined {
    const r = this.db.prepare(`SELECT * FROM work_queue WHERE id=?`).get(id) as Row | undefined
    return r ? toItem(r) : undefined
  }

  depth(opts?: { tenantId?: string; kind?: string; status?: WorkItem['status'] }): number {
    const cond: string[] = []; const args: unknown[] = []
    if (opts?.tenantId) { cond.push('tenant_id=?'); args.push(opts.tenantId) }
    if (opts?.kind) { cond.push('kind=?'); args.push(opts.kind) }
    if (opts?.status) { cond.push('status=?'); args.push(opts.status) }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
    return (this.db.prepare(`SELECT count(*) c FROM work_queue ${where}`).get(...args) as { c: number }).c
  }
}
