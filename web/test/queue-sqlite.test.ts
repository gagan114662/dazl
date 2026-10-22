// Contract tests for SqliteQueue: the same semantics as the in-memory
// reference adapter, plus the one property memory cannot have - durability
// across a simulated restart (new handle over the same file).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SqliteQueue } from '../lib/queue/sqlite.ts'

const T0 = 1_700_000_000
const noJitter = () => 0.5

function tmpDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync('/tmp/qsq-')
  const path = `${dir}/q.db`
  return { db: new Database(path), path }
}

test('enqueue dedupe: active duplicate returns existing id; terminal releases key', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  const a = q.enqueue({ tenantId: 'A', kind: 'scan', dedupeKey: 'k1', now: T0 })
  const b = q.enqueue({ tenantId: 'A', kind: 'scan', dedupeKey: 'k1', now: T0 })
  assert.deepEqual(b, { id: a.id, created: false })
  // different tenant with same key is independent
  const c = q.enqueue({ tenantId: 'B', kind: 'scan', dedupeKey: 'k1', now: T0 })
  assert.equal(c.created, true)
  const claim = q.claim({ now: T0, leaseSeconds: 100 })
  q.complete(claim!.token)
  const d = q.enqueue({ tenantId: claim!.item.tenantId, kind: 'scan', dedupeKey: 'k1', now: T0 })
  assert.equal(d.created, true) // key released at terminal
  db.close(); rmSync(path, { force: true })
})

test('claim: per-tenant cap and global FIFO order match the reference adapter', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'a1', now: T0 })
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'a2', now: T0 + 1 })
  q.enqueue({ tenantId: 'B', kind: 'scan', id: 'b1', now: T0 + 2 })
  const c1 = q.claim({ now: T0 + 5 }) // all three eligible (notBefore == createdAt here)
  assert.equal(c1!.item.id, 'a1')
  // A at cap 1 -> next claim skips a2 and takes B's head
  const c2 = q.claim({ now: T0 + 5 })
  assert.equal(c2!.item.id, 'b1')
  db.close(); rmSync(path, { force: true })
})

test('fencing: stale token rejected after lease expiry re-claim', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  const c1 = q.claim({ now: T0, leaseSeconds: 100 })
  assert.equal(q.claim({ now: T0 + 99 }), null)
  // reaped at T0+100, re-pended with backoff (attempt 1 -> +30s)
  assert.equal(q.claim({ now: T0 + 100 }), null)
  const c2 = q.claim({ now: T0 + 130 })
  assert.notEqual(c2!.token, c1!.token)
  assert.equal(q.fail(c1!.token), 'stale') // old worker fenced off
  assert.equal(q.complete(c1!.token), false)
  assert.equal(q.complete(c2!.token), true)
  db.close(); rmSync(path, { force: true })
})

test('reap backoff: crash-looping job cannot spin through attempts', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  const { id } = q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 }) // maxAttempts 3
  q.claim({ now: T0, leaseSeconds: 10 })
  assert.equal(q.reapExpired(T0 + 10), 1)
  assert.equal(q.claim({ now: T0 + 39 }), null) // notBefore T0+40
  q.claim({ now: T0 + 40, leaseSeconds: 10 })
  q.reapExpired(T0 + 51)
  assert.equal(q.get(id)!.notBefore, T0 + 51 + 60)
  const c3 = q.claim({ now: T0 + 111, leaseSeconds: 10 })
  assert.equal(c3!.item.attempts, 3)
  q.reapExpired(T0 + 122)
  assert.equal(q.get(id)!.status, 'failed')
  assert.equal(q.get(id)!.lastError, 'timeout')
  db.close(); rmSync(path, { force: true })
})

test('fail: retryable backs off; non-retryable fails immediately', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'r1', now: T0 })
  const c = q.claim({ now: T0 })
  assert.equal(q.fail(c!.token, { error: 'boom', now: T0 }), 'retry')
  assert.equal(q.get('r1')!.notBefore, T0 + 30) // attempt 1 -> 30s
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'n1', now: T0 })
  const c2 = q.claim({ now: T0, kinds: ['scan'], perTenantInFlight: 5 })
  // r1 is backed off, n1 claimed
  assert.equal(c2!.item.id, 'n1')
  assert.equal(q.fail(c2!.token, { retryable: false, error: 'key_rejected' }), 'failed')
  db.close(); rmSync(path, { force: true })
})

test('caller-supplied id must be unique, including against terminal items', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'fixed', now: T0 })
  const c = q.claim({ now: T0 })
  q.complete(c!.token)
  assert.throws(() => q.enqueue({ tenantId: 'A', kind: 'scan', id: 'fixed', now: T0 }), /already exists/)
  db.close(); rmSync(path, { force: true })
})

test('durability: claims, attempts and fencing tokens survive a restart', () => {
  const { db, path } = tmpDb()
  let q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'd1', now: T0 })
  const c1 = q.claim({ now: T0, leaseSeconds: 100 })
  const tokenBefore = c1!.token
  db.close() // simulate crash mid-claim
  const db2 = new Database(path)
  q = new SqliteQueue(db2, { rng: noJitter })
  // lease still held: no claim before expiry; fencing token did not reset
  assert.equal(q.claim({ now: T0 + 50 }), null)
  const item = q.get('d1')!
  assert.equal(item.status, 'claimed')
  assert.equal(item.attempts, 1)
  // after expiry + backoff, re-claim gets a NEW, strictly later token
  q.reapExpired(T0 + 100)
  const c2 = q.claim({ now: T0 + 130 })
  assert.ok(c2!.token > tokenBefore)
  assert.equal(q.complete(c1!.token), false) // pre-crash token stays stale
  db2.close(); rmSync(path, { force: true })
})

test('depth filters by tenant, kind and status', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  q.enqueue({ tenantId: 'A', kind: 'monitor', now: T0 })
  q.enqueue({ tenantId: 'B', kind: 'scan', now: T0 })
  assert.equal(q.depth(), 3)
  assert.equal(q.depth({ tenantId: 'A' }), 2)
  assert.equal(q.depth({ kind: 'scan' }), 2)
  assert.equal(q.depth({ tenantId: 'A', kind: 'scan', status: 'pending' }), 1)
  db.close(); rmSync(path, { force: true })
})

// --- Reviewer-2 regression battery (blocking findings on 04dc453) ---

test('reap clobber regression: stale reaper cannot revert a live claim (two connections)', () => {
  const dir = mkdtempSync('/tmp/qsq-')
  const dbA = new Database(`${dir}/q.db`)
  const dbB = new Database(`${dir}/q.db`)
  const qA = new SqliteQueue(dbA, { rng: noJitter })
  const qB = new SqliteQueue(dbB, { rng: noJitter })
  qA.enqueue({ tenantId: 'A', kind: 'scan', id: 'victim', now: T0 })
  qA.claim({ now: T0, leaseSeconds: 10 })
  // A begins reapExpired(T0+50): its SELECT sees the expired row, then stalls.
  const staleRead = dbA.prepare(
    `SELECT * FROM work_queue WHERE status='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`).all(T0 + 50) as { id: string }[]
  assert.deepEqual(staleRead.map(r => r.id), ['victim'])
  // B honestly reaps (backoff to T0+80) and re-claims with a long live lease.
  qB.claim({ now: T0 + 50 })
  const c2 = qB.claim({ now: T0 + 80, leaseSeconds: 1000 })
  assert.ok(c2)
  // A's stalled conditional release now lands with the OLD token: 0 rows.
  const ch = dbA.prepare(`UPDATE work_queue SET status=?, last_error=?,
      not_before = COALESCE(?, not_before),
      claimed_at=NULL, lease_expires_at=NULL, claim_token=NULL,
      dedupe_key = CASE WHEN ? IN ('done','failed') THEN NULL ELSE dedupe_key END
    WHERE id=? AND status='claimed' AND claim_token=?`)
    .run('pending', null, T0 + 50 + 30, 'pending', 'victim', 1)
  assert.equal(ch.changes, 0, 'stale write must be a no-op')
  assert.equal(qB.complete(c2!.token), true, 'live claim survives')
  dbA.close(); dbB.close(); rmSync(dir, { recursive: true, force: true })
})

test('enqueue race regression: dedupe-index conflict returns existing item, not a false PK error', () => {
  const dir = mkdtempSync('/tmp/qsq-')
  const dbA = new Database(`${dir}/q.db`)
  const dbB = new Database(`${dir}/q.db`)
  const qA = new SqliteQueue(dbA, { rng: noJitter })
  const qB = new SqliteQueue(dbB, { rng: noJitter })
  const a = qA.enqueue({ tenantId: 'A', kind: 'scan', dedupeKey: 'race-key', now: T0 })
  // B's INSERT conflicts on the partial dedupe index (the race's loser path).
  const b = qB.enqueue({ tenantId: 'A', kind: 'scan', dedupeKey: 'race-key', now: T0 })
  assert.deepEqual(b, { id: a.id, created: false })
  // A genuine PK collision (caller-supplied id) still throws.
  assert.throws(() => qB.enqueue({ tenantId: 'A', kind: 'scan', id: a.id, now: T0 }), /already exists/)
  dbA.close(); dbB.close(); rmSync(dir, { recursive: true, force: true })
})

test('kinds: [] claims nothing (fail closed, parity with memory adapter)', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  assert.equal(q.claim({ now: T0, kinds: [] }), null)
  db.close(); rmSync(path, { force: true })
})

test('same-second claims follow insertion order (rowid tiebreak)', () => {
  const { db, path } = tmpDb()
  const q = new SqliteQueue(db, { rng: noJitter })
  q.enqueue({ tenantId: 'A', kind: 'scan', id: 'zz-first', now: T0 })
  q.enqueue({ tenantId: 'B', kind: 'scan', id: 'aa-second', now: T0 }) // same second, id sorts earlier
  const c1 = q.claim({ now: T0, leaseSeconds: 100 })
  assert.equal(c1!.item.id, 'zz-first')
  db.close(); rmSync(path, { force: true })
})
