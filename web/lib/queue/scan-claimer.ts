// Scan claiming through the shared work queue (DbQueue), so several app instances on one Postgres share scans: each
// scan is claimed by exactly one instance, and a scan whose instance died is taken over once its lease runs out.
// Behind DAZL_SCAN_SHARED_QUEUE=1 (default OFF); kickRunner (lib/scan/runner.ts) calls kickSharedScanQueue instead of
// its own claimers when the flag is on. Off, nothing here runs.
//
// Two stores, passed separately:
//   queue  - where work_queue lives: getDb() (Postgres when DATABASE_URL is set, else the app's SQLite file).
//   domain - where scan_jobs lives. Today that is the runner's raw SQLite handle (wrapped as a Db), so on Postgres the
//            queue is shared but the scan rows are still per instance; the runner's storage port (next step) makes it
//            getDb() too. The claim rules do not change between the two.
// One kick:
//   1. Reap: a running scan stale past the lease (its worker died) goes back to pending, or, at the attempt cap
//      (MAX_ATTEMPTS), fails as 'timeout': the legacy reaper's own statement (reapStaleJobs), so a scan is never run a
//      fourth time on either path.
//   2. Mirror: every pending scan the legacy claimer would take (the same funding filter as claimKeyedJob: the tenant
//      has a saved key, or the scan is trial-funded) gets a queue item with the scan's id. Idempotent; a terminal item
//      for a scan that is pending again is retired and re-enqueued (a new scheduling epoch; scan_jobs.attempts keeps
//      counting).
//   3. While this instance has a free run slot: claim one item, then bind the scan row with the runner's own guard
//      (pending -> running, attempts + 1). A row that is already finished, cancelled or failed completes the item
//      without running; a running row (a live attempt elsewhere, or a dead one the reaper has not freed yet) releases it
//      for a retry. The bound scan runs; its outcome is mapped back onto the item by claim token, so a claim that was
//      reaped and re-claimed meanwhile changes nothing.
import type { Db } from '../db/client.ts'
import { captureError } from '../ops/errors.ts'
import { MAX_ATTEMPTS, STALE_RUNNING_S } from '../scan/store.ts'
import { DbQueue } from './db.ts'

export const sharedScanQueue = (env: Record<string, string | undefined> = process.env) => env.DAZL_SCAN_SHARED_QUEUE === '1'

// The row claimKeyedJob returns, column for column.
const JOB_COLUMNS = 'id, user_id, business_name, industry, location, attempts, query, icp, sources, funded_by, watch_id, csv_domain, run_budget, spend_reserved_usd'
export interface ClaimedScan { id: string; user_id: string; attempts: number }

export interface SharedScanDeps<J extends ClaimedScan> {
  queue: Db
  domain: Db
  run: (job: J) => Promise<'done' | 'failed' | 'retry'>
  // an exception that escaped run(): the caller fails the scan row (fenced); the item is then failed, not retried
  onCrash: (job: J, e: unknown) => void
  slots: { available(): boolean; acquire(): void; release(): void }
  track?: (job: J) => () => void
  leaseSeconds?: number
  now?: () => number
}

const nowS = () => Math.floor(Date.now() / 1000)

// The legacy reaper (reapStaleJobs in lib/scan/store.ts and store-db.ts), with the lease as a parameter.
export async function reapStaleScans(domain: Db, leaseSeconds: number, now: number): Promise<number> {
  return (await domain.run(
    `UPDATE scan_jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
       error = CASE WHEN attempts >= ? THEN 'timeout' ELSE error END,
       finished_at = CASE WHEN attempts >= ? THEN ? ELSE finished_at END,
       claimed_at = NULL
     WHERE status = 'running' AND claimed_at < ?`,
    [MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS, now, now - leaseSeconds])).changes
}

export async function mirrorScans(domain: Db, q: DbQueue, now: number): Promise<number> {
  const rows = await domain.all<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM scan_jobs
     WHERE status = 'pending'
       AND (user_id IN (SELECT tenant_id FROM tenant_llm_keys) OR funded_by = 'trial')
     ORDER BY created_at, insert_seq`)
  let n = 0
  for (const r of rows) {
    const existing = await q.get(r.id)
    if (existing && (existing.status === 'pending' || existing.status === 'claimed')) continue
    if (existing) await q.retire(r.id)
    try {
      await q.enqueue({ id: r.id, tenantId: r.user_id, kind: 'scan', now })
      n++
    } catch (e) {
      // another instance mirrored the same scan first: fine when the winner is that scan; anything else is real
      const winner = await q.get(r.id)
      if (!winner || winner.tenantId !== r.user_id || winner.kind !== 'scan') throw e
    }
  }
  return n
}

export async function kickSharedScanQueue<J extends ClaimedScan>(d: SharedScanDeps<J>): Promise<void> {
  const lease = d.leaseSeconds ?? STALE_RUNNING_S
  const clock = d.now ?? nowS
  const q = new DbQueue(d.queue)
  await reapStaleScans(d.domain, lease, clock())
  await mirrorScans(d.domain, q, clock())
  while (d.slots.available()) {
    // No per-tenant or global cap beyond this instance's run slots, as with the legacy claimer. Round-robin across
    // tenants (#355): a free slot goes to the tenant served longest ago, so one tenant's backlog cannot hold every slot
    // while another tenant's scan waits.
    const claim = await q.claim({ kinds: ['scan'], leaseSeconds: lease, now: clock(), perTenantInFlight: 1_000_000, maxInFlight: 1_000_000, order: 'round_robin' })
    if (!claim) return
    const job = await d.domain.get<J>(
      `UPDATE scan_jobs SET status = 'running', attempts = attempts + 1, claimed_at = ?
       WHERE id = ? AND status = 'pending' RETURNING ${JOB_COLUMNS}`,
      [clock(), claim.item.id])
    if (!job) {
      const row = await d.domain.get<{ status: string }>('SELECT status FROM scan_jobs WHERE id = ?', [claim.item.id])
      if (!row || (row.status !== 'pending' && row.status !== 'running')) await q.complete(claim.token) // finished or cancelled: nothing to run
      else await q.fail(claim.token, { retryable: true, error: 'domain_row_not_bindable' }) // a live attempt holds it
      continue
    }
    const bound = { ...job, attempts: Number(job.attempts) } as J
    d.slots.acquire()
    const untrack = d.track?.(bound)
    const token = claim.token
    void d.run(bound)
      .catch(e => { d.onCrash(bound, e); return 'failed' as const })
      .then(async outcome => {
        if (outcome === 'done') await q.complete(token)
        else await q.fail(token, { retryable: outcome === 'retry', error: outcome === 'retry' ? 'executor_retry' : 'executor_failed' })
      })
      .catch(e => { captureError(e, { source: 'worker', where: 'shared-queue:settle', tenantId: bound.user_id, ref: bound.id }) })
      .finally(() => { untrack?.(); d.slots.release() })
  }
}
