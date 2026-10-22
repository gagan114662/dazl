// Queue slice: claiming/execution interface for dazl's background work.
//
// Today every workload is executed inline in one Node process:
//   - scan jobs:      claimKeyedJob / kickRunner (web/lib/scan/runner.ts)
//   - followups, sequences, watches, monitors, index checks:
//                     sequential loops in POST /api/internal/tick (web/app/api/internal/tick/route.ts)
// That coupling means one tenant's backlog runs ahead of every other tenant
// (global FIFO in claimKeyedJob), retries are re-pended immediately with no
// backoff (failOrRetry), and a slow tenant in the tick loop delays everyone
// behind them. This module defines the seam that decouples "what is due"
// from "who is executing it right now", without touching those files.
//
// The invariants below mirror semantics the current code already relies on,
// so a later SQL backend (SQLite first, Postgres FOR UPDATE SKIP LOCKED after
// the data-layer migration) can be swapped in without changing callers:
//
//   - Claim fencing: a claim hands out a monotonically increasing token.
//     complete/fail with a stale token is rejected, exactly like finish()
//     in runner.ts refusing to write when scan_jobs.attempts has moved on.
//     The token fences only the queue row: a worker that mutates domain
//     tables (leads, sequences, followups) must keep its own domain-level
//     ownership check, the way scan writes guard on scan_jobs.attempts.
//     Adding those guards is part of each wiring PR, not this slice.
//   - Leases: a claimed item expires after leaseSeconds and becomes
//     claimable again (reapExpired), mirroring reapStaleJobs in store.ts
//     (STALE_RUNNING_S = 20 min default).
//   - Attempts: each claim increments attempts; after maxAttempts the item
//     fails permanently (MAX_ATTEMPTS = 3 in store.ts).
//   - Idempotent enqueue: an optional dedupeKey makes re-enqueue of the same
//     logical work a no-op while the first copy is still active. Keys are
//     namespaced per tenant+kind so one tenant can never suppress another
//     tenant's work.
//
// This directory owns only NEW files. Wiring the existing runner and tick
// route onto this interface is a separate change; see web/docs/queue-slice.md.

export type WorkStatus = 'pending' | 'claimed' | 'done' | 'failed'

export interface WorkItem {
  id: string
  tenantId: string
  // Open string, not an enum: today's kinds are 'scan', 'followup', 'sequence',
  // 'watch', 'monitor', 'index-check', and the PG backend must not need a code
  // change when a workload is added.
  kind: string
  status: WorkStatus
  attempts: number
  maxAttempts: number
  // Epoch seconds. Item is claimable when notBefore <= now; fail(retryable)
  // pushes this into the future via the backoff policy.
  notBefore: number
  createdAt: number
  claimedAt: number | null
  leaseExpiresAt: number | null
  // Monotonic fencing token for the live claim; null while unclaimed.
  claimToken: number | null
  lastError: string | null
}

export interface EnqueueInput {
  tenantId: string
  kind: string
  // Optional idempotency handle, e.g. `monitor:${monitorId}:${dueDay}` so the
  // weekly monitor tick cannot double-enqueue the same run. Namespaced by
  // tenant+kind internally; active duplicates return the existing item id.
  dedupeKey?: string
  // Caller-supplied id (e.g. an existing scan_jobs.id) so the queue row and
  // the domain row stay the same identity. Defaults to a random id.
  id?: string
  notBefore?: number
  maxAttempts?: number
  now?: number
}

export interface EnqueueResult {
  id: string
  // false when an active item with the same dedupe key already existed.
  created: boolean
}

export interface ClaimOptions {
  now?: number
  // Restrict which kinds this worker executes (Hermes claims 'scan' only).
  kinds?: string[]
  // Per-tenant fairness/backpressure cap: how many items one tenant may have
  // claimed at once. Default 1 - a tenant's scans share one LLM key and quota,
  // so parallel runs of the same tenant buy nothing and starve others.
  perTenantInFlight?: number
  // Global concurrency cap. The scan runner maps SCAN_MAX_CONCURRENT (3) here.
  maxInFlight?: number
  // Lease length in seconds; scan semantics map STALE_RUNNING_S (1200) here.
  leaseSeconds?: number
  // Restrict claiming to these tenant ids (tenant-scoped rollout). Items for
  // other tenants stay queued but are never claimed - including ids removed
  // from the list after enqueue.
  tenants?: string[]
}

export interface Claim {
  item: WorkItem
  token: number
  leaseExpiresAt: number
}

export interface FailOptions {
  error?: string
  // false mirrors failOrRetry's auth path: a rejected key fails the job
  // outright ('key_rejected') instead of burning attempts.
  retryable?: boolean
  now?: number
}

// 'stale' = the token no longer owns the item (reaped and/or re-claimed);
// the caller must NOT write results, matching finish()'s silent no-op.
export type FailOutcome = 'retry' | 'failed' | 'stale'

export interface QueueAdapter {
  enqueue(input: EnqueueInput): EnqueueResult
  claim(opts?: ClaimOptions): Claim | null
  complete(token: number, opts?: { now?: number }): boolean
  fail(token: number, opts?: FailOptions): FailOutcome
  // Return expired claims to pending with backoff (or failed past
  // maxAttempts). Called inside claim() too, so no separate cron is
  // required - same shape as reapStaleJobs being called on reads, but with
  // retry spacing reapStaleJobs does not have.
  reapExpired(now?: number): number
  get(id: string): WorkItem | undefined
  depth(opts?: { tenantId?: string; kind?: string; status?: WorkStatus }): number
}

export const DEFAULT_LEASE_S = 20 * 60 // == STALE_RUNNING_S in web/lib/scan/store.ts
export const DEFAULT_MAX_ATTEMPTS = 3 // == MAX_ATTEMPTS in web/lib/scan/store.ts
