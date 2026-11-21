import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateSpendPools } from '../lib/llm/spend-pool.ts'
import { markerEvidence, resolveMarker } from '../lib/ops/spend-marker.ts'

const T0 = 1_800_000_000
function setup() {
  const db = new Database(':memory:'); migrateSpendPools(db)
  db.exec(`CREATE TABLE scan_spend_calls (id TEXT PRIMARY KEY, user_id TEXT, scan_job_id TEXT, attempt INTEGER, kind TEXT, reserve_usd REAL, actual_usd REAL, status TEXT, reason TEXT, created_at INTEGER, settled_at INTEGER);
           CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, error TEXT, claimed_at INTEGER, finished_at INTEGER)`)
  const pool = db.prepare('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, 0, 0, ?)')
  pool.run('W', 'd:2027-01-15', 2.4, T0); pool.run('W', 'p:nabc123456', 1.85, T0); pool.run('W', 'p:nact123456', 0.5, T0); pool.run('W', 'p:abcdef0123', 0.3, T0)
  db.prepare("INSERT INTO scan_spend_calls VALUES ('nabc123456','W','job1',1,'llm.anthropic.web_search',1.85,NULL,'reserved',NULL,?,NULL)").run(T0)
  db.prepare("INSERT INTO scan_spend_calls VALUES ('nact123456','W','job2',1,'llm.anthropic.web_search',0.5,NULL,'reserved',NULL,?,NULL)").run(T0)
  db.prepare("INSERT INTO scan_jobs VALUES ('job1','W','failed','accounting_uncertain',NULL,?)").run(T0 + 5)
  db.prepare("INSERT INTO scan_jobs VALUES ('job2','W','running',NULL,?,NULL)").run(T0)
  return db
}

test('read-first evidence: finished call resolvable; running and unattributed markers are not', () => {
  const db = setup()
  const ev = Object.fromEntries(markerEvidence(db, 'W', T0 + 7200).map(e => [e.period, e]))
  assert.equal(ev['p:nabc123456'].resolvable, true)
  assert.equal(ev['p:nact123456'].resolvable, false); assert.match(ev['p:nact123456'].why, /running/)
  assert.equal(ev['p:abcdef0123'].resolvable, false); assert.match(ev['p:abcdef0123'].why, /unattributed/)
  assert.equal(markerEvidence(db, 'other', T0).length, 0, 'another workspace sees nothing')
})
test('resolving keeps the worst-case dollars, records the reason, and refuses without evidence', () => {
  const db = setup()
  assert.throws(() => resolveMarker(db, 'W', 'p:nact123456', 'checked logs, still running', T0 + 7200), /running/)
  assert.throws(() => resolveMarker(db, 'W', 'p:abcdef0123', 'no idea where it came from', T0 + 7200), /unattributed/)
  assert.throws(() => resolveMarker(db, 'W', 'p:nabc123456', 'short', T0 + 7200), /reason/)
  resolveMarker(db, 'W', 'p:nabc123456', 'job1 failed accounting_uncertain; no settle logged', T0 + 7200)
  const rows = Object.fromEntries((db.prepare("SELECT period, reserved_usd FROM tenant_spend_pools WHERE tenant_id='W'").all() as { period: string; reserved_usd: number }[]).map(r => [r.period, r.reserved_usd]))
  assert.deepEqual(rows, { 'd:2027-01-15': 2.4, 'r:nabc123456': 1.85, 'p:nact123456': 0.5, 'p:abcdef0123': 0.3 })
  const call = db.prepare("SELECT status, reason FROM scan_spend_calls WHERE id='nabc123456'").get() as { status: string; reason: string }
  assert.equal(call.status, 'kept'); assert.match(call.reason, /^operator: job1 failed/)
})
