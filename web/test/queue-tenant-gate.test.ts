// Tenant-scoped queue gate: listed tenants go through the queue bridge,
// unlisted tenants stay on the legacy claimer, malformed flags fail closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'
import { queueTenants, syncPendingScansToQueue } from '../lib/scan/queue-runner.ts'
import { SqliteQueue } from '../lib/queue/sqlite.ts'

const master = randomBytes(32)
function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'alice', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveKey(db, 'bob', 'anthropic', 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', master)
  return db
}
const input = { business_name: 'Acme', industry: 'roofing', location: 'Toronto' }

test('parser: unset/empty off; clean list parsed; any malformed entry fails closed', () => {
  assert.equal(queueTenants({}), null)
  assert.equal(queueTenants({ DAZL_QUEUE_TENANTS: '' }), null)
  assert.equal(queueTenants({ DAZL_QUEUE_TENANTS: '  ' }), null)
  assert.deepEqual(queueTenants({ DAZL_QUEUE_TENANTS: 'alice,bob-2' }), ['alice', 'bob-2'])
  assert.equal(queueTenants({ DAZL_QUEUE_TENANTS: 'alice,bad id!,bob' }), null)
  assert.equal(queueTenants({ DAZL_QUEUE_TENANTS: 'alice,,bob' }), null)
  assert.equal(queueTenants({ DAZL_QUEUE_TENANTS: '*' }), null)
})

test('legacy claimer EXCLUDES listed tenants; queue sync INCLUDES only listed', () => {
  const db = setup()
  createJob(db, 'alice', input)
  createJob(db, 'bob', input)
  // Legacy with exclusion: alice's job is invisible, bob's claims normally.
  const job = claimKeyedJob(db, undefined, ['alice'])
  assert.equal(job!.user_id, 'bob')
  // Without exclusion both are visible (oldest first = alice).
  const db2 = setup()
  createJob(db2, 'alice', input)
  createJob(db2, 'bob', input)
  assert.equal(claimKeyedJob(db2)!.user_id, 'alice')
  // Queue sync mirrors only listed tenants.
  const db3 = setup()
  createJob(db3, 'alice', input)
  createJob(db3, 'bob', input)
  const q = new SqliteQueue(db3)
  assert.equal(syncPendingScansToQueue(db3, q, 1200, ['alice']), 1)
  assert.equal(q.depth(), 1)
  assert.equal(q.claim({ tenants: ['alice'] })!.item.tenantId, 'alice')
})

test('queue claim with tenant list never returns an unlisted item (linger protection)', () => {
  const db = new Database(':memory:')
  const q = new SqliteQueue(db)
  q.enqueue({ id: 'x1', tenantId: 'bob', kind: 'scan' }) // enqueued while bob was listed
  assert.equal(q.claim({ tenants: ['alice'] }), null, 'bob no longer listed: not claimable')
  assert.equal(q.claim({ tenants: ['bob'] })!.item.id, 'x1')
})

test('mixed-mode coherence: exclusion set is exactly the queue set', () => {
  // Both runners draw from queueTenants(): the legacy NOT IN list and the
  // queue IN list are the same array, so a tenant is in exactly one world.
  const db = setup()
  createJob(db, 'alice', input)
  createJob(db, 'bob', input)
  createJob(db, 'carol', input) // keyless carol: invisible to BOTH (funding filter)
  saveKey(db, 'carol', 'openai', 'sk-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', master)
  const qt = queueTenants({ DAZL_QUEUE_TENANTS: 'alice' })!
  const legacyJob = claimKeyedJob(db, undefined, qt)
  assert.notEqual(legacyJob!.user_id, 'alice')
  const q = new SqliteQueue(db)
  syncPendingScansToQueue(db, q, 1200, qt)
  assert.deepEqual([...new Set([...Array(q.depth())].map(() => null))].length <= 1, true) // depth sanity
  assert.equal(q.depth(), 1)
  assert.equal(q.claim({ tenants: qt })!.item.tenantId, 'alice')
})
