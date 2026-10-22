// In-process queue adapter: the reference implementation of the QueueAdapter
// contract, and the adapter a single-process deployment can use today for
// workloads that do not need to survive a restart. It is deliberately free of
// better-sqlite3 and Next imports so its tests run with plain `node --test`.
//
// Fairness model: among tenants with claimable work and room under
// perTenantInFlight, the tenant whose oldest eligible item is oldest wins
// (inter-tenant head-of-line FIFO); within a tenant, oldest eligible first.
// That is the strongest fairness the current single-process runner can offer
// without reordering one tenant's own jobs, and it removes the starvation
// claimKeyedJob's global FIFO allows (one tenant's CSV batch ahead of every
// other tenant's manual scan).

import { randomBytes } from 'node:crypto'
import { backoffSeconds, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.ts'
import {
  DEFAULT_LEASE_S,
  DEFAULT_MAX_ATTEMPTS,
  type Claim,
  type ClaimOptions,
  type EnqueueInput,
  type EnqueueResult,
  type FailOptions,
  type FailOutcome,
  type QueueAdapter,
  type WorkItem,
  type WorkStatus,
} from './types.ts'

const nowS = () => Math.floor(Date.now() / 1000)

export class InProcessQueue implements QueueAdapter {
  private items = new Map<string, WorkItem>()
  // Namespaced dedupe key -> item id, kept only while the item is active
  // (pending or claimed). Terminal items release the key so a recurring
  // workload (weekly monitor) can enqueue its next run.
  private dedupe = new Map<string, string>()
  private byToken = new Map<number, string>()
  private tokenCounter = 0
  private backoff: BackoffPolicy
  private rng: () => number

  constructor(opts: { backoff?: BackoffPolicy; rng?: () => number } = {}) {
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF
    this.rng = opts.rng ?? Math.random
  }

  private ns(tenantId: string, kind: string, key: string): string {
    return `${tenantId}${kind}${key}`
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    const now = input.now ?? nowS()
    if (input.dedupeKey) {
      const existing = this.dedupe.get(this.ns(input.tenantId, input.kind, input.dedupeKey))
      if (existing) {
        const item = this.items.get(existing)
        if (item && (item.status === 'pending' || item.status === 'claimed')) return { id: item.id, created: false }
      }
    }
    const id = input.id ?? randomBytes(12).toString('hex')
    if (this.items.has(id)) throw new Error(`queue item id already exists: ${id}`)
    const item: WorkItem = {
      id,
      tenantId: input.tenantId,
      kind: input.kind,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      notBefore: input.notBefore ?? now,
      createdAt: now,
      claimedAt: null,
      leaseExpiresAt: null,
      claimToken: null,
      lastError: null,
    }
    this.items.set(id, item)
    if (input.dedupeKey) this.dedupe.set(this.ns(input.tenantId, input.kind, input.dedupeKey), id)
    return { id, created: true }
  }

  claim(opts: ClaimOptions = {}): Claim | null {
    const now = opts.now ?? nowS()
    const lease = opts.leaseSeconds ?? DEFAULT_LEASE_S
    const maxInFlight = opts.maxInFlight ?? 3
    const perTenant = opts.perTenantInFlight ?? 1
    this.reapExpired(now)

    let inFlight = 0
    const tenantInFlight = new Map<string, number>()
    for (const it of this.items.values()) {
      if (it.status === 'claimed') {
        inFlight++
        tenantInFlight.set(it.tenantId, (tenantInFlight.get(it.tenantId) ?? 0) + 1)
      }
    }
    if (inFlight >= maxInFlight) return null

    const kinds = opts.kinds ? new Set(opts.kinds) : null
    // Best (oldest) eligible item per tenant, over tenants with capacity left.
    let best: WorkItem | null = null
    const headByTenant = new Map<string, WorkItem>()
    for (const it of this.items.values()) {
      if (it.status !== 'pending' || it.notBefore > now) continue
      if (kinds && !kinds.has(it.kind)) continue
      if ((tenantInFlight.get(it.tenantId) ?? 0) >= perTenant) continue
      const head = headByTenant.get(it.tenantId)
      if (!head || it.createdAt < head.createdAt || (it.createdAt === head.createdAt && it.id < head.id)) headByTenant.set(it.tenantId, it)
    }
    for (const head of headByTenant.values()) {
      if (!best || head.createdAt < best.createdAt || (head.createdAt === best.createdAt && head.tenantId < best.tenantId)) best = head
    }
    if (!best) return null

    const token = ++this.tokenCounter
    best.status = 'claimed'
    best.attempts += 1
    best.claimedAt = now
    best.leaseExpiresAt = now + lease
    best.claimToken = token
    this.byToken.set(token, best.id)
    return { item: { ...best }, token, leaseExpiresAt: best.leaseExpiresAt }
  }

  private ownedBy(token: number): WorkItem | null {
    const id = this.byToken.get(token)
    if (!id) return null
    const item = this.items.get(id)
    if (!item || item.status !== 'claimed' || item.claimToken !== token) return null
    return item
  }

  private release(item: WorkItem, status: WorkStatus, error: string | null): void {
    item.status = status
    item.claimedAt = null
    item.leaseExpiresAt = null
    item.lastError = error
    if (item.claimToken !== null) this.byToken.delete(item.claimToken)
    item.claimToken = null
    if (status === 'done' || status === 'failed') {
      for (const [k, v] of this.dedupe) if (v === item.id) { this.dedupe.delete(k); break }
    }
  }

  complete(token: number): boolean {
    const item = this.ownedBy(token)
    if (!item) return false
    this.release(item, 'done', null)
    return true
  }

  fail(token: number, opts: FailOptions = {}): FailOutcome {
    const item = this.ownedBy(token)
    if (!item) return 'stale'
    const now = opts.now ?? nowS()
    const error = (opts.error ?? 'error').slice(0, 200) // matches scan_jobs.error cap
    const retryable = opts.retryable !== false
    if (!retryable || item.attempts >= item.maxAttempts) {
      this.release(item, 'failed', error)
      return 'failed'
    }
    item.notBefore = now + backoffSeconds(item.attempts, this.backoff, this.rng)
    this.release(item, 'pending', error)
    return 'retry'
  }

  reapExpired(now: number = nowS()): number {
    let n = 0
    for (const it of this.items.values()) {
      if (it.status !== 'claimed' || it.leaseExpiresAt === null || it.leaseExpiresAt > now) continue
      // Parity with reapStaleJobs: a timed-out attempt goes straight back to
      // pending (no backoff) or fails as 'timeout' once attempts are spent.
      if (it.attempts >= it.maxAttempts) this.release(it, 'failed', 'timeout')
      else this.release(it, 'pending', it.lastError)
      n++
    }
    return n
  }

  get(id: string): WorkItem | undefined {
    const it = this.items.get(id)
    return it ? { ...it } : undefined
  }

  depth(opts: { tenantId?: string; kind?: string; status?: WorkStatus } = {}): number {
    let n = 0
    for (const it of this.items.values()) {
      if (opts.tenantId && it.tenantId !== opts.tenantId) continue
      if (opts.kind && it.kind !== opts.kind) continue
      if (opts.status && it.status !== opts.status) continue
      n++
    }
    return n
  }
}
