// Queue-backed scan execution (DAZL_QUEUE_SCANS=on, default OFF).
//
// Wiring-preparation slice, scans only - other kinds are explicitly out of
// scope until they have a defined domain fence. Design invariants:
//
// 1. Domain fencing is UNCHANGED. finish() in runner.ts still guards on
//    scan_jobs.status='running' AND attempts=N; the bridge bumps attempts
//    with the same conditional UPDATE claimKeyedJob uses, inside the same
//    better-sqlite3 transaction as the queue claim (nested savepoint), so
//    queue row and domain row move atomically.
// 2. Queue row = scheduling state (lease, backoff, fencing token);
//    scan_jobs row = execution state. After the executor resolves, the
//    bridge maps the DOMAIN outcome onto the queue item by token; a stale
//    token (reaped, re-claimed) makes complete/fail a rejected no-op.
// 3. No dual runner: the single gate is in kickRunner - env on means the
//    legacy claimKeyedJob path never runs scans. Rollback = unset the env;
//    queue rows sit inert and pending scan_jobs claim via the legacy path.
// 4. Cron ownership unchanged: the existing */5 cron hits /api/internal/
//    tick which calls kickRunner; the gate is inside kickRunner, so no cron
//    or route changes are part of activation.
import type Database from 'better-sqlite3'
import { SqliteQueue } from '../queue/sqlite.ts'
import type { RunDeps, Job } from './runner.ts'

export type ScanExecutor = (db: Database.Database, job: Job, deps: RunDeps) => Promise<'done' | 'failed' | 'retry'>

// Mirror every pending, key-funded scan job into the queue. Caller-supplied
// id keeps queue row and domain row the same identity; re-sync is idempotent.
// Mirrors claimKeyedJob's funding filter exactly: tenant key or trial-funded.
export function syncPendingScansToQueue(db: Database.Database, q: SqliteQueue): number {
  const rows = db.prepare(
    `SELECT id, user_id FROM scan_jobs
     WHERE status = 'pending'
       AND (user_id IN (SELECT tenant_id FROM tenant_llm_keys) OR funded_by = 'trial')
     ORDER BY created_at, rowid`,
  ).all() as { id: string; user_id: string }[]
  let n = 0
  for (const r of rows) {
    if (q.get(r.id)) continue
    q.enqueue({ id: r.id, tenantId: r.user_id, kind: 'scan' })
    n++
  }
  return n
}

const MAX_CONCURRENT = Number(process.env.SCAN_MAX_CONCURRENT || 3)
let active = 0

// One queue-mode kick: claim via SqliteQueue, bind the domain row in the same
// transaction, run the executor, map the domain outcome back by token.
export async function kickQueueRunner(
  db: Database.Database,
  deps: RunDeps,
  executor: ScanExecutor,
  opts?: { leaseSeconds?: number; now?: number },
): Promise<void> {
  const q = new SqliteQueue(db)
  syncPendingScansToQueue(db, q)
  while (active < MAX_CONCURRENT) {
    const claim = q.claim({ kinds: ['scan'], leaseSeconds: opts?.leaseSeconds, now: opts?.now })
    if (!claim) return
    // Bind the domain row. Guard mirrors claimKeyedJob (status='pending'),
    // plus the crash-recovery case: the queue only re-claims after the
    // previous claim's lease expired, so a 'running' row whose claimed_at is
    // older than that lease belongs to the dead attempt and is safe to take.
    // A FRESH running row is a live attempt - binding it would double-run,
    // so the bind fails and the queue claim is released instead.
    const lease = claim.leaseExpiresAt - (claim.item.claimedAt ?? claim.leaseExpiresAt)
    const ch = db.prepare(
      `UPDATE scan_jobs SET status='running', attempts = attempts + 1,
         claimed_at = CAST(strftime('%s','now') AS INTEGER)
       WHERE id = ? AND (status='pending'
         OR (status='running' AND claimed_at <= CAST(strftime('%s','now') AS INTEGER) - ?))`,
    ).run(claim.item.id, lease)
    if (ch.changes !== 1) {
      q.fail(claim.token, { retryable: true, error: 'domain_row_not_bindable' })
      continue
    }
    const jobRow = db.prepare(
      `SELECT id, user_id, business_name, industry, location, attempts, query, icp, sources, funded_by, watch_id, csv_domain
       FROM scan_jobs WHERE id = ?`,
    ).get(claim.item.id) as Job
    active++
    const token = claim.token
    void executor(db, { ...jobRow, attempts: jobRow.attempts }, deps)
      .catch((e) => { console.error('queue scan run crashed', jobRow.id, e); return 'retry' as const })
      .then((outcome) => {
        // Token fencing first: if this claim was reaped and re-claimed,
        // complete/fail below are rejected and the newer attempt owns the row.
        if (outcome === 'done') q.complete(token)
        else if (outcome === 'failed') q.fail(token, { retryable: false, error: 'executor_failed' })
        else q.fail(token, { retryable: true, error: 'executor_retry' })
      })
      .finally(() => { active-- })
  }
}
