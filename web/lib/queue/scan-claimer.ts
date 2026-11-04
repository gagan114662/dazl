// Scan claiming through the shared work queue (DbQueue), so several app instances on one Postgres share scans: each
// scan is claimed by exactly one instance, and a scan whose instance died is taken over once its lease runs out.
// The default scan path (#355): kickRunner (lib/scan/runner.ts) calls kickSharedScanQueue instead of its in-process
// claimers unless DAZL_SCAN_SHARED_QUEUE=0 (the rollback, see sharedScanQueue).
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
//   3. While this instance has a free run slot: claim one item (round-robin across tenants, at most
//      SCAN_PER_TENANT_MAX of one tenant's scans claimed at once across every instance), then bind the scan row with the runner's own guard
//      (pending -> running, attempts + 1). A row that is already finished, cancelled or failed completes the item
//      without running; a running row (a live attempt elsewhere, or a dead one the reaper has not freed yet) releases it
//      for a retry. The bound scan runs; its outcome is mapped back onto the item by claim token, so a claim that was
//      reaped and re-claimed meanwhile changes nothing.
import type { Db } from '../db/client.ts'
import { captureError } from '../ops/errors.ts'
import { MAX_ATTEMPTS, STALE_RUNNING_S } from '../scan/store.ts'
import { DbQueue } from './db.ts'

// On unless DAZL_SCAN_SHARED_QUEUE is 0 (#355). 0 is the rollback to the in-process claimer (claimKeyedJob, plus the
// DAZL_QUEUE_TENANTS canary) and takes a restart. Unset, empty and 1 keep the queue; any other value keeps it too and is
// reported once, so a typo never drops the per-tenant scan limit.
let reportedFlag = false
export function sharedScanQueue(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.DAZL_SCAN_SHARED_QUEUE ?? '').trim()
  if (v === '0') return false
  if (v !== '' && v !== '1' && !reportedFlag) { reportedFlag = true; console.error('DAZL_SCAN_SHARED_QUEUE is neither 0 nor 1 - scans stay on the shared work queue') }
  return true
}

// How many of one tenant's scans may be claimed at once, counted in work_queue, so across every instance (#355).
// Default 1: a tenant's scans share one key and one spend pool (the pool admits one unsettled call at a time), so a
// second parallel scan of the same tenant buys little and takes a run slot another tenant is waiting for. 1 to 8; a
// malformed or out-of-range value means 1, the stricter limit, and is reported.
export const SCAN_PER_TENANT_DEFAULT = 1
let reportedLimit = false
export function scanPerTenantLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SCAN_PER_TENANT_MAX
  if (raw === undefined || raw.trim() === '') return SCAN_PER_TENANT_DEFAULT
  if (!/^[1-8]$/.test(raw.trim())) {
    if (!reportedLimit) { reportedLimit = true; console.error('SCAN_PER_TENANT_MAX must be an integer from 1 to 8 - using 1') }
    return SCAN_PER_TENANT_DEFAULT
  }
  return Number(raw.trim())
}

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
  // token: the queue claim, so a shutdown can hand it back (requeueInFlightForShutdown in lib/scan/runner.ts)
  track?: (job: J, token: number) => () => void
  leaseSeconds?: number
  // per-tenant claim limit; default scanPerTenantLimit()
  perTenantInFlight?: number
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
  const perTenant = d.perTenantInFlight ?? scanPerTenantLimit()
  await reapStaleScans(d.domain, lease, clock())
  await mirrorScans(d.domain, q, clock())
  while (d.slots.available()) {
    // Fair service (#355). Round-robin: a free slot goes to the tenant served longest ago. Per-tenant limit: a tenant
    // with perTenant scans claimed gets no more until one settles, so one tenant's backlog or slow provider cannot hold
    // every slot while another tenant's scan waits. The scan lane: only scan claims count against these caps, so
    // runtime-worker items (lib/workers) never take a scan's place, nor scans theirs. No global cap beyond this
    // instance's run slots.
    const claim = await q.claim({ kinds: ['scan'], lane: true, leaseSeconds: lease, now: clock(), perTenantInFlight: perTenant, maxInFlight: 1_000_000, order: 'round_robin' })
    if (!claim) return
    // The bind is scoped to the item's tenant as well as its id: an item whose tenant is not the scan's owner (a
    // corrupted or hand-made row) binds nothing and completes, so the per-tenant limit is never charged to the wrong
    // tenant and the scan is re-mirrored under its owner on the next kick.
    const job = await d.domain.get<J>(
      `UPDATE scan_jobs SET status = 'running', attempts = attempts + 1, claimed_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending' RETURNING ${JOB_COLUMNS}`,
      [clock(), claim.item.id, claim.item.tenantId])
    if (!job) {
      const row = await d.domain.get<{ status: string }>('SELECT status FROM scan_jobs WHERE id = ? AND user_id = ?', [claim.item.id, claim.item.tenantId])
      if (!row || (row.status !== 'pending' && row.status !== 'running')) await q.complete(claim.token) // finished or cancelled: nothing to run
      else await q.fail(claim.token, { retryable: true, error: 'domain_row_not_bindable' }) // a live attempt holds it
      continue
    }
    const bound = { ...job, attempts: Number(job.attempts) } as J
    d.slots.acquire()
    const token = claim.token
    const untrack = d.track?.(bound, token)
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
