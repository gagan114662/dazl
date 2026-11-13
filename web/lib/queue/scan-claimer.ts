// Scan claiming through the shared work queue (DbQueue), so several app instances on one Postgres share scans: each
// scan is claimed by exactly one instance, and a scan whose instance died is taken over once its lease runs out.
// Behind DAZL_SCAN_SHARED_QUEUE=1 (default OFF; switching it on is a deploy-time step, docs/PLATFORM.md); kickRunner
// (lib/scan/runner.ts) calls kickSharedScanQueue instead of its own claimers when the flag is on. Off, nothing here runs.
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
import { instanceId } from '../ops/instance.ts'
import { isStaging } from '../staging.ts'

// Off unless DAZL_SCAN_SHARED_QUEUE is exactly 1. Any other set value (a typo, ' 1', 'true') stays off, today's
// in-process claimer, and is reported once so the operator sees the flag did not take.
let reportedFlag = false
export function sharedScanQueue(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.DAZL_SCAN_SHARED_QUEUE
  if (v === '1') return true
  if (v !== undefined && v !== '' && v !== '0' && !reportedFlag) { reportedFlag = true; console.error('DAZL_SCAN_SHARED_QUEUE is not exactly 1 - scans stay on the in-process claimer') }
  return false
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

// TEST-ONLY, staging only (#836): a pause between a scan's claim and its run. Read only with DAZL_ENV=staging AND
// DAZL_STAGING_SCAN_HOLD_MS set to 1..120000; production never reads it, and any other value is no pause. During the
// pause the scan is running under this instance's claim and has made no paid request, so restarting the instance in
// that window shows the restart path whole: the exit hook hands the scan and its claim back and the other worker runs
// it (attempt 2). Without the pause a restart usually lands inside a paid request, where the scan is deliberately not
// re-run (accounting_uncertain after the lease: lib/scan/store.ts reapStaleJobs), so that path could not be shown on
// demand. Nothing else changes: the same claim, bind, run and settle.
export function stagingScanHoldMs(env: Record<string, string | undefined> = process.env): number {
  if (!isStaging(env)) return 0
  const raw = env.DAZL_STAGING_SCAN_HOLD_MS?.trim()
  if (!raw || !/^\d{1,6}$/.test(raw)) return 0
  const n = Number(raw)
  return n >= 1 && n <= 120_000 ? n : 0
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
  // This instance, recorded on every claim it takes (work_queue.claimed_by and claim_log); default instanceId(), the
  // id /api/health reports. log: one line per claim and per settle; default the process log (the service journal).
  owner?: string
  log?: (line: string) => void
  // the staging-only pause before a claimed scan runs; default stagingScanHoldMs() (0 outside staging)
  holdMs?: number
}

import { settleReapedTrial } from '../billing/trial-reap.ts'
const nowS = () => Math.floor(Date.now() / 1000)

// The legacy reaper (reapStaleJobs in lib/scan/store.ts and store-db.ts), with the lease as a parameter.
export async function reapStaleScans(domain: Db, leaseSeconds: number, now: number): Promise<number> {
  const changes = (await domain.run(
    `UPDATE scan_jobs SET status = CASE WHEN EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND c.attempt = scan_jobs.attempts AND c.status = 'reserved') OR attempts >= ? THEN 'failed' ELSE 'pending' END,
       error = CASE WHEN EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND c.attempt = scan_jobs.attempts AND c.status = 'reserved') THEN 'accounting_uncertain' WHEN attempts >= ? THEN 'timeout' ELSE error END,
       finished_at = CASE WHEN EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = scan_jobs.id AND c.attempt = scan_jobs.attempts AND c.status = 'reserved') OR attempts >= ? THEN ? ELSE finished_at END,
       claimed_at = NULL
     WHERE status = 'running' AND claimed_at < ?`,
    [MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS, now, now - leaseSeconds])).changes
  if (changes > 0) await settleReapedTrial(domain, now)
  return changes
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
  const owner = d.owner ?? instanceId()
  const log = d.log ?? ((line: string) => console.log(line))
  await reapStaleScans(d.domain, lease, clock())
  await mirrorScans(d.domain, q, clock())
  while (d.slots.available()) {
    // Fair service (#355). Round-robin: a free slot goes to the tenant served longest ago. Per-tenant limit: a tenant
    // with perTenant scans claimed gets no more until one settles, so one tenant's backlog or slow provider cannot hold
    // every slot while another tenant's scan waits. The scan lane: only scan claims count against these caps, so
    // runtime-worker items (lib/workers) never take a scan's place, nor scans theirs. No global cap beyond this
    // instance's run slots.
    const claim = await q.claim({ kinds: ['scan'], lane: true, leaseSeconds: lease, now: clock(), perTenantInFlight: perTenant, maxInFlight: 1_000_000, order: 'round_robin', owner })
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
      // No scan was started under this claim; the journal says why, so a queue item that ends without a "claimed" line is
      // explained: the scan already ended (its own row has the outcome), or another attempt still holds it.
      if (!row || (row.status !== 'pending' && row.status !== 'running')) {
        await q.complete(claim.token) // finished or cancelled: nothing to run
        log(`[shared-queue] nothing to run scan=${claim.item.id} token=${claim.token} scan_status=${row?.status ?? 'missing'} instance=${owner}`)
      } else {
        await q.fail(claim.token, { retryable: true, error: 'domain_row_not_bindable' }) // a live attempt holds it
        log(`[shared-queue] not taken scan=${claim.item.id} token=${claim.token} scan_status=${row.status} instance=${owner} (another attempt holds it; retried later)`)
      }
      continue
    }
    const bound = { ...job, attempts: Number(job.attempts) } as J
    d.slots.acquire()
    const token = claim.token
    // The journal's side of the claim record (#836): scan id, the scan's attempt, the fencing token and this instance.
    // No tenant id and nothing of the scan's content.
    log(`[shared-queue] claimed scan=${bound.id} attempt=${bound.attempts} token=${token} instance=${owner}`)
    const untrack = d.track?.(bound, token)
    const hold = d.holdMs ?? stagingScanHoldMs()
    if (hold > 0) log(`[shared-queue] staging hold scan=${bound.id} attempt=${bound.attempts} ms=${hold} instance=${owner} (test-only: no paid request until it ends)`)
    void (hold > 0 ? new Promise<void>(r => setTimeout(r, hold)).then(() => d.run(bound)) : d.run(bound))
      .catch(e => { d.onCrash(bound, e); return 'failed' as const })
      .then(async outcome => {
        // applied=false: the token no longer owned the item (handed back, reaped or re-claimed), so nothing changed
        const applied = outcome === 'done' ? await q.complete(token)
          : (await q.fail(token, { retryable: outcome === 'retry', error: outcome === 'retry' ? 'executor_retry' : 'executor_failed' })) !== 'stale'
        log(`[shared-queue] settled scan=${bound.id} attempt=${bound.attempts} token=${token} outcome=${outcome} applied=${applied} instance=${owner}`)
      })
      .catch(e => { captureError(e, { source: 'worker', where: 'shared-queue:settle', tenantId: bound.user_id, ref: bound.id }) })
      .finally(() => { untrack?.(); d.slots.release() })
  }
}
