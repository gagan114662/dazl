// Audit retention through the REAL tick route (app/api/internal/tick/route.ts; lib/audit.ts auditRetention), run by
// test/audit-retention-tick.test.ts through the tenant-route loader. Automatic deletion of audit events is OFF until
// the owner chooses a period: a deployed tick with AUDIT_RETENTION_DAYS unset, off or invalid must delete nothing, and
// a valid explicit period deletes only events older than it, in bounded batches, with the table still append-only.
// Synthetic store, staging mode, no tenant has autopilot on (the tick's other work is idle); nothing is sent or fetched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { getDb } from '../../lib/db/client.ts'
import { AUDIT_RETENTION_MIN_DAYS, record } from '../../lib/audit.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
delete process.env.AUTOPILOT_ENABLED; delete process.env.AUTOPILOT_KILL; delete process.env.ACCOUNT_RETENTION_ENABLED

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const db = await getDb()
const DAY = 24 * 60 * 60, now = Math.floor(Date.now() / 1000)
const A = 'tenant-a', B = 'tenant-b'

// The trail as a deployment would have it: events of several ages in two workspaces.
const AGES = { ancient: 500 * DAY, old: 100 * DAY, fresh: 0 }
for (const t of [A, B]) for (const [age, s] of Object.entries(AGES)) await record(db, { tenantId: t, actorId: t, action: `x.${age}`, resourceType: 't' }, now - s)
const ids = () => (raw.prepare('SELECT id FROM audit_events ORDER BY id').all() as { id: string }[]).map(r => r.id)
const actions = (t: string) => (raw.prepare('SELECT action FROM audit_events WHERE tenant_id = ? ORDER BY at').all(t) as { action: string }[]).map(r => r.action)
const gate = () => raw.prepare('SELECT count(*) AS n FROM audit_purge_gate').get() as { n: number }
const appendOnly = () => {
  assert.throws(() => raw.prepare("UPDATE audit_events SET action = 'tampered'").run(), /append-only/)
  assert.throws(() => raw.prepare('DELETE FROM audit_events').run(), /append-only/)
  assert.equal(gate().n, 0, 'the purge gate exists only inside a purge')
}
const caught: ErrorRecord[] = []
setErrorSinks([r => { caught.push(r) }])
const retentionErrors = () => caught.filter(r => r.where === 'tick:audit-retention')
async function tickWith(value: string | undefined) {
  if (value === undefined) delete process.env.AUDIT_RETENTION_DAYS; else process.env.AUDIT_RETENTION_DAYS = value
  caught.length = 0
  const res = await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))
  assert.equal(res.status, 200)
  const body = await res.json() as { ok: boolean; skipped?: string; audit_retention: string | number; audit_purged: number }
  assert.equal(body.ok, true); assert.equal(body.skipped, undefined, 'the tick ran')
  return body
}

test('unset, off and invalid AUDIT_RETENTION_DAYS: the deployed tick deletes no audit event', async () => {
  const before = ids()
  assert.equal(before.length, 6)
  // the deployed default: nothing configured
  const unset = await tickWith(undefined)
  assert.deepEqual([unset.audit_retention, unset.audit_purged], ['off', 0])
  assert.deepEqual(ids(), before); assert.deepEqual(retentionErrors(), [], 'off is not an error')
  // explicitly off
  for (const v of ['', 'off', 'OFF', '0']) {
    const r = await tickWith(v)
    assert.deepEqual([r.audit_retention, r.audit_purged], ['off', 0], JSON.stringify(v))
    assert.deepEqual(ids(), before, JSON.stringify(v)); assert.deepEqual(retentionErrors(), [], JSON.stringify(v))
  }
  // invalid: nothing deleted, and the misconfiguration is reported (an alert, never a policy)
  for (const v of ['abc', '-5', '1.5', String(AUDIT_RETENTION_MIN_DAYS - 1), '400d', '1e3', 'true']) {
    const r = await tickWith(v)
    assert.deepEqual([r.audit_retention, r.audit_purged], ['invalid', 0], v)
    assert.deepEqual(ids(), before, v)
    assert.equal(retentionErrors().length, 1, `${v} is reported once per tick`)
    assert.ok(!JSON.stringify(retentionErrors()[0]).includes(`"${v}"`), 'the configured value itself is not in the report')
  }
  appendOnly()
})

test('a valid explicit period deletes only events older than it, in bounded batches, through the lease-fenced purge', async () => {
  // 400 days: the 500-day events go, the 100-day and fresh ones stay, in both workspaces
  const r400 = await tickWith('400')
  assert.deepEqual([r400.audit_retention, r400.audit_purged], [400, 2])
  for (const t of [A, B]) assert.deepEqual(actions(t), ['x.old', 'x.fresh'])
  assert.deepEqual(retentionErrors(), [])
  appendOnly()
  // the next tick under the same policy has nothing left to delete
  assert.equal((await tickWith('400')).audit_purged, 0)

  // the period is a boundary: an event just inside the floor period stays, one past it goes
  await record(db, { tenantId: A, actorId: A, action: 'x.inside', resourceType: 't' }, now - AUDIT_RETENTION_MIN_DAYS * DAY + 60)
  await record(db, { tenantId: A, actorId: A, action: 'x.past', resourceType: 't' }, now - AUDIT_RETENTION_MIN_DAYS * DAY - 60)
  const rMin = await tickWith(String(AUDIT_RETENTION_MIN_DAYS))
  assert.deepEqual([rMin.audit_retention, rMin.audit_purged], [AUDIT_RETENTION_MIN_DAYS, 3], 'the two 100-day events and the one past the floor')
  assert.deepEqual(actions(A), ['x.inside', 'x.fresh']); assert.deepEqual(actions(B), ['x.fresh'])

  // bounded: at most 1000 per tick, the rest on later ticks; fresh events are untouched throughout
  const insert = raw.prepare("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES (?, ?, ?, 'user', 'x.bulk', 't', 'allowed', '{}', ?, 0)")
  raw.transaction(() => { for (let i = 0; i < 1200; i++) insert.run(randomBytes(12).toString('hex'), B, B, now - 500 * DAY + i) })()
  const purged: number[] = []
  for (let i = 0; i < 3; i++) purged.push((await tickWith('400')).audit_purged)
  assert.deepEqual(purged, [1000, 200, 0])
  assert.deepEqual(actions(A), ['x.inside', 'x.fresh']); assert.deepEqual(actions(B), ['x.fresh'])
  assert.deepEqual(retentionErrors(), [])
  appendOnly()
  // and switching the policy off again stops deletion, with old events left as they are
  await record(db, { tenantId: B, actorId: B, action: 'x.ancient_again', resourceType: 't' }, now - 900 * DAY)
  assert.deepEqual([(await tickWith(undefined)).audit_purged, (await tickWith('off')).audit_purged], [0, 0])
  assert.deepEqual(actions(B), ['x.ancient_again', 'x.fresh'])
})
