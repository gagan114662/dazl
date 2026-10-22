import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InProcessQueue } from '../lib/queue/memory.ts'
import { backoffSeconds, nextEligibleAt, DEFAULT_BACKOFF } from '../lib/queue/backoff.ts'
import { DEFAULT_LEASE_S, DEFAULT_MAX_ATTEMPTS } from '../lib/queue/types.ts'

const T0 = 1_800_000_000
const noJitter = () => 0.5 // rng midpoint -> zero jitter offset

test('backoff: exponential growth, cap, deterministic under fixed rng', () => {
  const p = { baseSeconds: 30, factor: 2, capSeconds: 1800, jitter: 0.2 }
  assert.equal(backoffSeconds(1, p, noJitter), 30)
  assert.equal(backoffSeconds(2, p, noJitter), 60)
  assert.equal(backoffSeconds(3, p, noJitter), 120)
  assert.equal(backoffSeconds(99, p, noJitter), 1800) // capped
  assert.equal(nextEligibleAt(T0, 1, p, noJitter), T0 + 30)
  // jitter stays inside the +/-20% band
  for (const r of [0, 0.25, 0.75, 1]) {
    const v = backoffSeconds(2, p, () => r)
    assert.ok(v >= 48 && v <= 72, `jitter band: ${v}`)
  }
  assert.ok(DEFAULT_BACKOFF.jitter > 0)
})

test('defaults mirror the scan store constants', () => {
  assert.equal(DEFAULT_LEASE_S, 20 * 60) // STALE_RUNNING_S
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3) // MAX_ATTEMPTS
})

test('enqueue: dedupe key is idempotent while active, per-tenant namespaced', () => {
  const q = new InProcessQueue()
  const a1 = q.enqueue({ tenantId: 'A', kind: 'monitor', dedupeKey: 'm1:2026-10-22', now: T0 })
  const a2 = q.enqueue({ tenantId: 'A', kind: 'monitor', dedupeKey: 'm1:2026-10-22', now: T0 })
  assert.equal(a1.created, true)
  assert.equal(a2.created, false)
  assert.equal(a2.id, a1.id)
  // same key under another tenant is independent work, never suppressed
  const b1 = q.enqueue({ tenantId: 'B', kind: 'monitor', dedupeKey: 'm1:2026-10-22', now: T0 })
  assert.equal(b1.created, true)
  assert.notEqual(b1.id, a1.id)
  // same key under another kind is independent too
  const aSeq = q.enqueue({ tenantId: 'A', kind: 'sequence', dedupeKey: 'm1:2026-10-22', now: T0 })
  assert.equal(aSeq.created, true)
  // terminal items release the key: the next weekly run can enqueue
  const c = q.claim({ now: T0, kinds: ['monitor'], perTenantInFlight: 5 })
  assert.ok(c)
  q.complete(c!.token)
  const again = q.enqueue({ tenantId: c!.item.tenantId, kind: 'monitor', dedupeKey: 'm1:2026-10-22', now: T0 + 10 })
  assert.equal(again.created, true)
})

test('enqueue: caller-supplied id must be unique', () => {
  const q = new InProcessQueue()
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'job1', now: T0 })
  assert.throws(() => q.enqueue({ tenantId: 'A', kind: 'scan', id: 'job1', now: T0 }))
})

test('claim: per-tenant fairness beats global FIFO order', () => {
  const q = new InProcessQueue()
  const a1 = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 + 1 })
  const b1 = q.enqueue({ tenantId: 'B', kind: 'scan', now: T0 + 2 })
  const first = q.claim({ now: T0 + 3 })
  assert.equal(first!.item.id, a1.id) // oldest head overall
  const second = q.claim({ now: T0 + 3 })
  assert.equal(second!.item.tenantId, 'B') // A is at its in-flight cap of 1
  assert.equal(second!.item.id, b1.id)
  q.complete(first!.token)
  const third = q.claim({ now: T0 + 4 })
  assert.equal(third!.item.tenantId, 'A') // A eligible again after completing
})

test('claim: global in-flight cap applies across tenants', () => {
  const q = new InProcessQueue()
  for (const t of ['A', 'B', 'C', 'D']) q.enqueue({ tenantId: t, kind: 'scan', now: T0 })
  const claims = [q.claim({ now: T0, maxInFlight: 2 }), q.claim({ now: T0, maxInFlight: 2 }), q.claim({ now: T0, maxInFlight: 2 })]
  assert.ok(claims[0] && claims[1])
  assert.equal(claims[2], null)
  assert.equal(q.depth({ status: 'claimed' }), 2)
})

test('claim: kinds filter keeps other work queued', () => {
  const q = new InProcessQueue()
  q.enqueue({ tenantId: 'A', kind: 'followup', now: T0 })
  assert.equal(q.claim({ now: T0, kinds: ['scan'] }), null)
  const c = q.claim({ now: T0, kinds: ['scan', 'followup'] })
  assert.equal(c!.item.kind, 'followup')
})

test('claim fencing: lease expiry re-queues, stale tokens are rejected', () => {
  const q = new InProcessQueue({ rng: noJitter })
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  const c1 = q.claim({ now: T0, leaseSeconds: 100 })
  assert.equal(c1!.item.attempts, 1)
  assert.equal(c1!.leaseExpiresAt, T0 + 100)
  // not yet expired: a second claim finds nothing
  assert.equal(q.claim({ now: T0 + 99 }), null)
  // expired at T0+100: claim() reaps inline, but the re-pend carries backoff
  // (attempt 1 -> +30s), so the item is not claimable until T0+130
  assert.equal(q.claim({ now: T0 + 100 }), null)
  assert.equal(q.get(id)!.status, 'pending')
  assert.equal(q.get(id)!.notBefore, T0 + 130)
  const c2 = q.claim({ now: T0 + 130 })
  assert.equal(c2!.item.id, id)
  assert.equal(c2!.item.attempts, 2)
  assert.notEqual(c2!.token, c1!.token)
  // the slow old attempt can no longer write (finish() parity)
  assert.equal(q.complete(c1!.token), false)
  assert.equal(q.fail(c1!.token), 'stale')
  assert.equal(q.complete(c2!.token), true)
  assert.equal(q.get(id)!.status, 'done')
})

test('reap backoff: a crash-looping job cannot spin through its attempts', () => {
  const q = new InProcessQueue({ rng: noJitter })
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 }) // maxAttempts 3
  // attempt 1: lease 10s, reaped at T0+10 -> notBefore T0+40 (attempt 1 -> 30s)
  q.claim({ now: T0, leaseSeconds: 10 })
  assert.equal(q.reapExpired(T0 + 10), 1)
  assert.equal(q.claim({ now: T0 + 39 }), null)
  // attempt 2: reaped again -> notBefore +60s from reap time
  const c2 = q.claim({ now: T0 + 40, leaseSeconds: 10 })
  q.reapExpired(T0 + 51)
  assert.equal(q.get(id)!.notBefore, T0 + 51 + 60)
  // attempt 3: reaped once more -> attempts spent, failed as timeout
  const c3 = q.claim({ now: T0 + 111, leaseSeconds: 10 })
  assert.equal(c3!.item.attempts, 3)
  q.reapExpired(T0 + 122)
  const item = q.get(id)!
  assert.equal(item.status, 'failed')
  assert.equal(item.lastError, 'timeout')
  assert.equal(q.claim({ now: T0 + 10_000 }), null)
})

test('reapExpired: past maxAttempts a timed-out attempt fails as timeout', () => {
  const q = new InProcessQueue()
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0, maxAttempts: 1 })
  q.claim({ now: T0, leaseSeconds: 10 })
  assert.equal(q.reapExpired(T0 + 11), 1)
  const item = q.get(id)!
  assert.equal(item.status, 'failed')
  assert.equal(item.lastError, 'timeout')
})

test('fail: retryable error backs off, item is not claimable until notBefore', () => {
  const q = new InProcessQueue({ rng: noJitter })
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  const c1 = q.claim({ now: T0 })
  assert.equal(q.fail(c1!.token, { error: 'rate_limited', now: T0 }), 'retry')
  const item = q.get(id)!
  assert.equal(item.status, 'pending')
  assert.equal(item.notBefore, T0 + 30) // DEFAULT_BACKOFF base, jitter zeroed
  assert.equal(q.claim({ now: T0 + 29 }), null)
  const c2 = q.claim({ now: T0 + 30 })
  assert.equal(c2!.item.id, id)
  assert.equal(c2!.item.attempts, 2)
})

test('fail: attempts are spent after maxAttempts, like failOrRetry', () => {
  const q = new InProcessQueue({ rng: noJitter })
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 }) // maxAttempts 3
  let c = q.claim({ now: T0 })
  assert.equal(q.fail(c!.token, { error: 'e', now: T0 }), 'retry')
  c = q.claim({ now: T0 + 30 })
  assert.equal(q.fail(c!.token, { error: 'e', now: T0 + 30 }), 'retry')
  c = q.claim({ now: T0 + 90 })
  assert.equal(q.fail(c!.token, { error: 'e', now: T0 + 90 }), 'failed')
  assert.equal(q.get(id)!.status, 'failed')
  assert.equal(q.claim({ now: T0 + 10_000 }), null)
})

test('fail: non-retryable error fails immediately (auth/key_rejected parity)', () => {
  const q = new InProcessQueue()
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  const c = q.claim({ now: T0 })
  assert.equal(q.fail(c!.token, { error: 'key_rejected', retryable: false, now: T0 }), 'failed')
  const item = q.get(id)!
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 1)
})

test('fail: error text capped at 200 chars like scan_jobs.error', () => {
  const q = new InProcessQueue()
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  const c = q.claim({ now: T0 })
  q.fail(c!.token, { error: 'x'.repeat(500), retryable: false })
  assert.equal(q.get(id)!.lastError!.length, 200)
})

test('depth: counts filter by tenant, kind and status', () => {
  const q = new InProcessQueue()
  q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  q.enqueue({ tenantId: 'A', kind: 'monitor', now: T0 })
  q.enqueue({ tenantId: 'B', kind: 'scan', now: T0 })
  q.claim({ now: T0 }) // A scan (oldest head)
  assert.equal(q.depth(), 3)
  assert.equal(q.depth({ tenantId: 'A' }), 2)
  assert.equal(q.depth({ kind: 'scan' }), 2)
  assert.equal(q.depth({ status: 'pending' }), 2)
  assert.equal(q.depth({ tenantId: 'A', status: 'claimed' }), 1)
})
