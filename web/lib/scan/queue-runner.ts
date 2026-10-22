// Queue-backed scan execution (DAZL_QUEUE_TENANTS tenant allowlist, default OFF).
//
// Wiring-preparation slice, scans only - other kinds are explicitly out of
// scope until they have a defined domain fence. Design invariants:
//
// 1. Domain fencing is UNCHANGED. finish() in runner.ts still guards on
//    scan_jobs.status='running' AND attempts=N; the bridge bumps attempts
//    with the same conditional UPDATE claimKeyedJob uses. NOTE: the queue
//    claim COMMITS before the domain bind runs - they are two transactions,
//    not one, so a crash between them leaves a claimed queue row with an
//    unbound domain row; the lease/reap + reconcile paths below recover that.
// 2. Queue row = scheduling state (lease, backoff, fencing token);
//    scan_jobs row = execution state. After the executor resolves, the
//    bridge maps the DOMAIN outcome onto the queue item by token; a stale
//    token (reaped, re-claimed) makes complete/fail a rejected no-op.
// 3. Mixed-mode routing: the single gate is in kickRunner - LISTED tenants
//    are claimed by this bridge, UNLISTED tenants keep running through the
//    legacy claimKeyedJob path in the same process. Both runners share one
//    slot budget (run-slots.ts) and this bridge claims first each kick.
//    Rollback = remove the tenant id from the env; queue rows sit inert and
//    pending scan_jobs claim via the legacy path.
// 4. Cron ownership unchanged: the existing */5 cron hits /api/internal/
//    tick which calls kickRunner; the gate is inside kickRunner, so no cron
//    or route changes are part of activation.
import type Database from 'better-sqlite3'
import { SqliteQueue } from '../queue/sqlite.ts'
import { slotAvailable, acquireSlot, releaseSlot } from './run-slots.ts'
import type { RunDeps, Job } from './runner.ts'

export type ScanExecutor = (db: Database.Database, job: Job, deps: RunDeps) => Promise<'done' | 'failed' | 'retry'>

// Mirror every pending, key-funded scan job into the queue. Caller-supplied
// id keeps queue row and domain row the same identity; re-sync is idempotent.
// Mirrors claimKeyedJob's funding filter exactly: tenant key or trial-funded.
export function syncPendingScansToQueue(db: Database.Database, q: SqliteQueue, leaseSeconds: number = QUEUE_LEASE_S, tenants?: string[]): number {
  // Mirrors pending jobs AND stale-running ones (claimed_at older than the
  // lease): the latter is the crash-recovery / env-flip path - a legacy- or
  // queue-claimed row whose worker died must re-enter scheduling, or it
  // would sit 'running' forever (queue mode does not call reapStaleJobs).
  // tenants: when set (tenant-scoped rollout), ONLY listed tenants mirror.
  const tenantFilter = tenants?.length ? `AND user_id IN (${tenants.map(() => '?').join(',')})` : ''
  const rows = db.prepare(
    `SELECT id, user_id FROM scan_jobs
     WHERE (status = 'pending'
            OR (status = 'running' AND claimed_at <= CAST(strftime('%s','now') AS INTEGER) - ?))
       AND (user_id IN (SELECT tenant_id FROM tenant_llm_keys) OR funded_by = 'trial')
       ${tenantFilter}
     ORDER BY created_at, rowid`,
  ).all(leaseSeconds, ...(tenants ?? [])) as { id: string; user_id: string }[]
  let n = 0
  for (const r of rows) {
    if (mirrorRow(q, r)) n++
  }
  return n
}

// Mirror one domain row. The get->enqueue window can lose a race to another
// PROCESS mirroring the same caller-supplied id; the PK error is then exact
// proof the row exists. Catch ONLY that error and re-read to verify the
// winner is the same job (same tenant+kind) - anything else is rethrown,
// never blanket-suppressed.
function mirrorRow(q: SqliteQueue, r: { id: string; user_id: string }): boolean {
  const existing = q.get(r.id)
  if (existing && (existing.status === 'pending' || existing.status === 'claimed')) return false
  if (existing) {
      // Orphan reconcile: the domain row is pending again but the queue item
      // died terminal (e.g. bind refusals spent its attempts while another
      // attempt owned the row). Retire the dead row and re-enqueue a FRESH
      // scheduling identity for the same domain id - fencing tokens stay
      // monotonic (meta table), queue attempts restart because this is a new
      // scheduling epoch, domain attempts in scan_jobs keep counting.
      q.retire(r.id)
    }
    try {
      q.enqueue({ id: r.id, tenantId: r.user_id, kind: 'scan' })
    } catch (e) {
      if (!(e as Error).message.includes('already exists')) throw e
      const winner = q.get(r.id)
      if (!winner || winner.tenantId !== r.user_id || winner.kind !== 'scan') throw e
      return false // another process mirrored it first - that is fine
    }
    return true
  }

// Tenant-scoped rollout flag. Unset/empty = queue mode OFF (pure legacy).
// Set = queue mode for the listed tenant ids ONLY. Fail closed: any malformed
// entry disables queue mode entirely (logged) - a bad flag must never widen
// into a global queue claim.
export function queueTenants(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.DAZL_QUEUE_TENANTS
  if (raw === undefined || raw.trim() === '') return null
  const parts = raw.split(',').map(t => t.trim())
  if (parts.some(t => !/^[A-Za-z0-9_-]+$/.test(t))) {
    console.error('DAZL_QUEUE_TENANTS malformed - queue mode disabled (fail closed)')
    return null
  }
  // Canary cap: queue mode is approved for ONE tenant at a time. A longer
  // list means a broader rollout was configured without the reviewed policy
  // (slot sharing beyond the adapter's perTenantInFlight=1 default is not
  // approved) - fail closed to pure legacy rather than widen activation by
  // an ops edit.
  if (parts.length > 1) {
    console.error('DAZL_QUEUE_TENANTS lists more than one tenant - canary cap is 1, queue mode disabled (fail closed)')
    return null
  }
  return parts
}

// One threshold source: the queue lease IS the store's stale-running window.
// Passing a different leaseSeconds to a kick (tests aside) would let a job be
// re-claimed while the legacy reaper still considers it fresh (or vice versa)
// and can double-run provider calls. Do not configure them apart.
const QUEUE_LEASE_S = Number(process.env.SCAN_STALE_RUNNING_S || 20 * 60)
// One queue-mode kick: claim via SqliteQueue, bind the domain row in the same
// transaction, run the executor, map the domain outcome back by token.
export async function kickQueueRunner(
  db: Database.Database,
  deps: RunDeps,
  executor: ScanExecutor,
  opts?: { leaseSeconds?: number; now?: number; tenants?: string[] },
): Promise<void> {
  const q = new SqliteQueue(db)
  syncPendingScansToQueue(db, q, opts?.leaseSeconds ?? QUEUE_LEASE_S, opts?.tenants)
  while (slotAvailable()) {
    // Canary slot policy, pinned EXPLICITLY (not inherited from the adapter
    // default, which a future adapter change could alter): the queue tenant
    // holds at most one in-flight slot, so a continuous queue backlog cannot
    // starve legacy tenants out of the shared budget.
    const claim = q.claim({ kinds: ['scan'], leaseSeconds: opts?.leaseSeconds ?? QUEUE_LEASE_S, now: opts?.now, tenants: opts?.tenants, perTenantInFlight: 1 })
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
    acquireSlot()
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
      .finally(() => { releaseSlot() })
  }
}
