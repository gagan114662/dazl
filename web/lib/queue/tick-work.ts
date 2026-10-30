// The tick's per-tenant work on the shared queue (#355): reply sync + follow-ups ('followup') and sequences
// ('sequence'), behind DAZL_TICK_QUEUE=1 (default OFF; the tick then runs its inline loops as before).
//   - Durable: each due tenant gets one active item per kind (dedupe key 'tick'), so a tick that runs out of budget or
//     dies leaves the rest queued. The next tick serves it first, and a dead tick's claims come back when their
//     lease runs out (reaped with backoff, failed past maxAttempts).
//   - Fair: claims run in the replies lane, round-robin across tenants, one item at a time. A tenant whose work is slow
//     or failing never holds the others behind it for more than one item, and the tenant served longest ago goes next.
//   - Bounded: no new claim once the tick's budget is spent. Work already running is never cut off mid-send; the lease
//     (lib/shared/lease.ts) is what bounds a stuck step.
//   - Fenced: the handlers write through the tick lease's fenced store, exactly as the inline loops do; the queue token
//     fences only the queue row (types.ts). When the lease is lost (StaleLeaseWrite / LeaseLost) the drain stops at
//     once and leaves its claim to expire: it never completes or fails an item it no longer owns the store for.
//   - A handler error is retried with backoff and dead-lettered past maxAttempts (DbQueue.failed / replay), instead of
//     being retried by every tick with no record.
import type { DbQueue } from './db.ts'
import { LANES, type Claim } from './types.ts'

export const tickQueueEnabled = (env: Record<string, string | undefined> = process.env) => env.DAZL_TICK_QUEUE === '1'

export const TICK_KINDS = ['followup', 'sequence'] as const
export type TickKind = typeof TICK_KINDS[number]
// A tick claim's lease: longer than one tenant's step (the tick lease's step budget is 10 min) so a live item is never
// reaped under a running handler; short enough that a dead tick's item is back within the hour.
export const TICK_ITEM_LEASE_S = 15 * 60

export interface TickDue { kind: TickKind; tenantIds: string[] }

// Queue each due tenant once per kind. An item already pending or claimed answers the dedupe instead of adding another.
export async function enqueueTickWork(q: DbQueue, due: TickDue[], now?: number): Promise<{ created: number; existing: number }> {
  let created = 0, existing = 0
  for (const d of due) for (const tenantId of new Set(d.tenantIds)) {
    const r = await q.enqueue({ tenantId, kind: d.kind, dedupeKey: 'tick', now })
    if (r.created) created++; else existing++
  }
  return { created, existing }
}

export type TickHandler = (tenantId: string, claim: Claim) => Promise<void>

export interface DrainOptions {
  budgetMs: number
  // Before each claim (lib/shared/lease.ts Lease.keep): throws when the tick may not start another step.
  keep?: () => Promise<void>
  // An error that means this tick lost its store: stop without touching the claim.
  isFenceError?: (e: unknown) => boolean
  onError?: (e: unknown, item: Claim['item']) => void
  clock?: () => number // ms
  now?: () => number // s, for the queue
}

export interface DrainResult { done: number; retried: number; failed: number; stoppedBy: 'empty' | 'budget' }

export async function drainTickWork(q: DbQueue, handlers: Record<TickKind, TickHandler>, opts: DrainOptions): Promise<DrainResult> {
  const clock = opts.clock ?? Date.now
  const deadline = clock() + opts.budgetMs
  const out: DrainResult = { done: 0, retried: 0, failed: 0, stoppedBy: 'empty' }
  for (;;) {
    if (clock() >= deadline) { out.stoppedBy = 'budget'; return out }
    await opts.keep?.()
    const c = await q.claim({ kinds: [...TICK_KINDS], lane: true, maxInFlight: LANES.replies.maxInFlight, perTenantInFlight: 1, order: 'round_robin', leaseSeconds: TICK_ITEM_LEASE_S, now: opts.now?.() })
    if (!c) return out
    try {
      await handlers[c.item.kind as TickKind](c.item.tenantId, c)
    } catch (e) {
      if (opts.isFenceError?.(e)) throw e
      opts.onError?.(e, c.item)
      const r = await q.fail(c.token, { error: e instanceof Error ? e.message : String(e), now: opts.now?.() })
      if (r === 'retry') out.retried++; else if (r === 'failed') out.failed++
      continue
    }
    if (await q.complete(c.token)) out.done++
  }
}
