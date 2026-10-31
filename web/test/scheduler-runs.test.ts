// lib/ops/scheduler-runs.ts: freshness states, per-tenant reasons, overdue due work and scrubbed failure reasons.
// The tick route end to end: test/scheduler-tick.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { failureReason, finishRun, operational, recordProgress, schedulerHealth, startRun, tenantFreshness, CRASHED_AFTER_S, OVERDUE_ALERT_S, REPLY_SYNC_STALE_S, STALE_AFTER_S } from '../lib/ops/scheduler-runs.ts'

const NOW = 1_900_000_000, DAY = 86_400
const lease = { owner: 'o', generation: 7 }
const store = () => { const db = new Database(':memory:'); migrateAllSqlite(db); return db }
const state = async (db: Database.Database, now: number) => (await operational(db, now)).state

test('operational state: never ran, running, fresh, stale after missed ticks, crashed when a run never finishes', async () => {
  const db = store()
  assert.equal(await state(db, NOW), 'never_ran')
  const r = await startRun(db, lease, NOW - 60)
  assert.equal(await state(db, NOW), 'stale', 'running with no earlier completion is not fresh')
  await finishRun(db, r, 'ok', undefined, NOW - 30)
  assert.equal(await state(db, NOW), 'fresh'); assert.equal((await operational(db, NOW)).lease_generation, 7)
  await startRun(db, lease, NOW - 10)
  assert.equal(await state(db, NOW), 'running')
  assert.equal(await state(db, NOW + STALE_AFTER_S + 60), 'crashed', 'the run is older than the lease TTL')
  assert.ok(STALE_AFTER_S + 60 > CRASHED_AFTER_S)
  const db2 = store(); await finishRun(db2, await startRun(db2, lease, NOW - STALE_AFTER_S - 120), 'ok', undefined, NOW - STALE_AFTER_S - 60)
  assert.equal(await state(db2, NOW), 'stale')
  const db3 = store(); await finishRun(db3, await startRun(db3, lease, NOW - 60), 'failed', new Error('boom'), NOW - 50)
  assert.equal(await state(db3, NOW), 'stale', 'a failed run is not a completion'); assert.equal((await operational(db3, NOW)).last_error, 'Error: boom')
})

test('tenant reasons: reply sync stale; due work overdue; idle tenants raise nothing; counts only in the operator view', async () => {
  const db = store()
  await finishRun(db, await startRun(db, lease, NOW - 60), 'ok', undefined, NOW - 30)
  // A: reply sync succeeded long ago, attempted since without success (failing once, not yet blocked)
  await recordProgress(db, 'r', 'A', 'reply_sync', { outcome: 'success' }, NOW - REPLY_SYNC_STALE_S - 600)
  await recordProgress(db, 'r', 'A', 'reply_sync', { outcome: 'failure', error: new Error('gmail_unavailable') }, NOW - 60)
  const a = await tenantFreshness(db, 'A', NOW)
  assert.deepEqual(a.reasons, ['reply_sync_stale']); assert.equal(a.state, 'stale')
  // B: an active sequence whose step 2 was due a day ago
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1', 'B', 'l1', 'x@co.example', 'Subject here', 'A body long enough for the check.', 'sent', ?)").run(NOW - 4 * DAY)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('s1', 'B', 'l1', 'm1', 'x@co.example', 'active')").run()
  const f = await tenantFreshness(db, 'B', NOW)
  assert.equal(f.oldest_due?.overdue_s, DAY); assert.deepEqual(f.reasons, ['due_work_overdue'])
  assert.equal((await tenantFreshness(db, 'B', NOW - 4 * DAY + 3 * DAY + OVERDUE_ALERT_S - 10)).reasons.length, 0, 'just due is not overdue')
  assert.equal((await tenantFreshness(db, 'C', NOW)).state, 'idle')
  const h = await schedulerHealth(db, NOW)
  assert.deepEqual(h.tenants, { tracked: 2, blocked: 0, held: 0, reply_sync_stale: 1, overdue: 1, oldest_overdue_s: DAY })
  assert.equal(h.ok, false)
  for (const leak of ['"A"', '"B"', 'gmail_unavailable', 'x@co.example']) assert.ok(!JSON.stringify(h).includes(leak), leak)
  // the scheduler being stale shows on each tenant with work
  assert.ok((await tenantFreshness(db, 'B', NOW + STALE_AFTER_S + 60)).reasons.includes('scheduler_stale'))
})

test('failure reasons are scrubbed and capped', () => {
  const r = failureReason(new TypeError('fetch failed for pat@acme.example with Bearer abc.def at https://x.test/a?token=zzz\nsecond line'))
  assert.equal(r.includes('pat@acme.example') || r.includes('abc.def') || r.includes('token=zzz') || r.includes('second line'), false, r)
  assert.match(r, /^TypeError: fetch failed for <email>/)
  assert.ok(failureReason(new Error('x'.repeat(500))).length <= 200)
})

test('health response: an unmigrated store reads as never ran (200), not an error', async () => {
  const { schedulerHealthResponse } = await import('../lib/ops/scheduler-runs.ts')
  const r = await schedulerHealthResponse(new Database(':memory:'), NOW)
  assert.equal(r.status, 200); assert.equal((await r.json()).operational.state, 'never_ran')
})
