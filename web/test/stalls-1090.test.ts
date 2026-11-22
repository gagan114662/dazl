// #1090: lib/ops/stalls.ts counts stalled workspaces (mailbox needs reconnect, autopilot on with every waiting first
// touch held for over a day, scans stuck in 'running') on an in-memory store, and /api/health/scheduler carries the
// counts and nothing that names a workspace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { schedulerHealthResponse } from '../lib/ops/scheduler-runs.ts'
import { HELD_AFTER_S, SCAN_STUCK_AFTER_S, stallCounts } from '../lib/ops/stalls.ts'

const NOW = 1_900_000_000
const store = () => { const db = new Database(':memory:'); migrateAllSqlite(db); return db }
const mailbox = (db: Database.Database, tenant: string, status: string) =>
  db.prepare('INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES (?, ?, ?, ?)').run(tenant, `${tenant}@mailbox.example`, 'ct', status)
const autopilot = (db: Database.Database, tenant: string, enabled: number) =>
  db.prepare('INSERT INTO autopilot_settings (tenant_id, enabled) VALUES (?, ?)').run(tenant, enabled)
let seq = 0
const waiting = (db: Database.Database, tenant: string, createdAt: number) =>
  db.prepare("INSERT INTO autopilot_work (message_id, tenant_id, lead_id, reason, next_at, authority, created_at) VALUES (?, ?, 'lead', 'daily_cap', NULL, '{}', ?)").run(`m${++seq}`, tenant, createdAt)
const scan = (db: Database.Database, id: string, status: 'pending' | 'running' | 'done', claimedAt: number | null) => {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES (?, 'tenant-scan', 'Name', 'industry', 'place', ?)").run(id, NOW - 10 * SCAN_STUCK_AFTER_S)
  if (status !== 'pending') db.prepare("UPDATE scan_jobs SET status = 'running', claimed_at = ? WHERE id = ?").run(claimedAt, id)
  if (status === 'done') db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
}

test('an empty store has no stalls', async () => {
  assert.deepEqual(await stallCounts(store(), NOW), { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 0 })
})

test('needs_reconnect counts mailboxes that need the user, not healthy ones', async () => {
  const db = store()
  mailbox(db, 'a', 'active'); mailbox(db, 'b', 'needs_reconnect'); mailbox(db, 'c', 'needs_reconnect')
  assert.equal((await stallCounts(db, NOW)).needs_reconnect, 2)
})

test('held_over_24h: autopilot on, first touches waiting, and every one of them for more than a day', async () => {
  const db = store()
  autopilot(db, 'all-old', 1); waiting(db, 'all-old', NOW - HELD_AFTER_S - 60); waiting(db, 'all-old', NOW - 3 * HELD_AFTER_S)
  autopilot(db, 'one-fresh', 1); waiting(db, 'one-fresh', NOW - 2 * HELD_AFTER_S); waiting(db, 'one-fresh', NOW - 600)   // something new is still arriving
  autopilot(db, 'nothing-waiting', 1)                                                                                   // on and idle: not a stall
  autopilot(db, 'switched-off', 0); waiting(db, 'switched-off', NOW - 2 * HELD_AFTER_S)                                // the workspace's own choice
  waiting(db, 'no-settings', NOW - 2 * HELD_AFTER_S)
  assert.equal((await stallCounts(db, NOW)).held_over_24h, 1)
  // the boundary: held for exactly a day is counted; a second less is not
  const edge = store(); autopilot(edge, 't', 1); waiting(edge, 't', NOW - HELD_AFTER_S)
  assert.equal((await stallCounts(edge, NOW)).held_over_24h, 1)
  assert.equal((await stallCounts(edge, NOW - 1)).held_over_24h, 0)
  // it clears as soon as the held work goes out
  db.prepare("DELETE FROM autopilot_work WHERE tenant_id = 'all-old'").run()
  assert.equal((await stallCounts(db, NOW)).held_over_24h, 0)
})

test('scans_stuck: running past the reap deadline plus one tick; a live, pending or finished scan is not counted', async () => {
  const db = store()
  scan(db, 'stuck', 'running', NOW - SCAN_STUCK_AFTER_S - 1)
  scan(db, 'never-claimed', 'running', null)                    // falls back to its (old) creation time
  scan(db, 'live', 'running', NOW - 30)
  scan(db, 'at-deadline', 'running', NOW - SCAN_STUCK_AFTER_S)  // not past it yet
  scan(db, 'queued', 'pending', null)
  scan(db, 'finished', 'done', NOW - 5 * SCAN_STUCK_AFTER_S)
  assert.equal((await stallCounts(db, NOW)).scans_stuck, 2)
})

test('/api/health/scheduler carries the counts, names no workspace, and its status does not depend on them', async () => {
  const db = store()
  const clean = await schedulerHealthResponse(db, NOW)
  assert.deepEqual((await clean.json()).stalls, { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 0 })
  mailbox(db, 'tenant-secret-1', 'needs_reconnect')
  autopilot(db, 'tenant-secret-2', 1); waiting(db, 'tenant-secret-2', NOW - 2 * HELD_AFTER_S)
  scan(db, 'scan-secret-3', 'running', NOW - 2 * SCAN_STUCK_AFTER_S)
  const r = await schedulerHealthResponse(db, NOW), text = await r.text()
  assert.equal(r.status, clean.status, 'stalls inform; they do not change ok or the status code')
  assert.deepEqual(JSON.parse(text).stalls, { needs_reconnect: 1, held_over_24h: 1, scans_stuck: 1 })
  for (const leak of ['tenant-secret', 'scan-secret', 'tenant-scan', 'mailbox.example']) assert.ok(!text.includes(leak), `${leak} must not be in the response`)
})

test('a store without those tables reports stalls null instead of failing the endpoint', async () => {
  const r = await schedulerHealthResponse(new Database(':memory:'), NOW)
  assert.equal(r.status, 200); assert.equal((await r.json()).stalls, null)
})
