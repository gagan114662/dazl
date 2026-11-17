// #698 live-check defects: every reason/hold code the tick can emit has plain copy; disabling autopilot clears a blocked first_touch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { DRAIN_HOLD_REASONS, HOLD_REASONS, recordProgress, schedulerHealth, startRun, finishRun, tenantFreshness, type Kind } from '../lib/ops/scheduler-runs.ts'
import { reasonCopy, holdCopy, kindCopy } from '../lib/ops/scheduler-copy.ts'
import { disable } from '../lib/outreach/autopilot.ts'

const KINDS: Kind[] = ['reply_sync', 'followups', 'sequences', 'first_touch', 'autopilot']
const RAW = /^[a-z0-9]+(_[a-z0-9]+)+$|^[a-z]+$/

test('AC-1: every Kind _failing and scheduler/tenant reason has plain-language copy', () => {
  const reasons = [...KINDS.map(k => `${k}_failing`), 'scheduler_stale', 'scheduler_crashed', 'scheduler_never_ran', 'scheduler_failed', 'scheduler_lease_lost', 'reply_sync_stale', 'due_work_overdue']
  for (const r of reasons) { const c = reasonCopy(r); assert.ok(c && c !== r && !RAW.test(c) && c.includes(' '), `no copy for ${r}`) }
})

test('AC-2: every hold reason and kind has plain-language copy', () => {
  for (const h of [...HOLD_REASONS, ...DRAIN_HOLD_REASONS, 'reading_not_enabled', 'reply_sync_partial', 'unknown']) { const c = holdCopy(h); assert.ok(c && c !== h && c.includes(' '), `no copy for hold ${h}`) }
  for (const k of KINDS) { const c = kindCopy(k); assert.ok(c && c !== k && !c.includes('_'), `no copy for kind ${k}`) }
})

test('AC-3: 3 first_touch failures, then disable: tenant not blocked, health 200', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const now = Math.floor(Date.now() / 1000)
  await finishRun(db, await startRun(db, { owner: 'o', generation: 1 }, now - 60), 'ok', undefined, now - 30)
  for (let i = 3; i >= 1; i--) await recordProgress(db, 'r', 'T', 'first_touch', { outcome: 'failure', error: new Error('uncertain_send') }, now - i * 10)
  assert.equal((await tenantFreshness(db, 'T', now)).state, 'blocked')
  disable(db, 'T')
  const f = await tenantFreshness(db, 'T', now)
  assert.notEqual(f.state, 'blocked', JSON.stringify(f.reasons))
  assert.equal((await schedulerHealth(db, now)).ok, true)
})
