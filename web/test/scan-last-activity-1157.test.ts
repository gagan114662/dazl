// #1157 line 2: while a scan runs, the page says when it last made progress, and a quiet scan says so plainly
// instead of an open-ended "Still running". Last activity = the newest provider call sent or settled for this job
// (owner-scoped), else the claim time; nothing recorded stays null.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { readLastActivity } from '../lib/scan/status-reads.ts'
import { lastActivityNote, QUIET_AFTER_S } from '../lib/scan/progress.ts'

bothEngines('status carries last_progress_at: newest call sent/settled, owner-scoped, claim time before any call', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'software', location: 'Bangalore' }, '{}')
  const fresh = await readScanStatus(db, 'A', job)
  assert.equal(fresh?.last_progress_at, null)   // nothing claimed, nothing called: never an invented time
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000 WHERE id = ?", [job])
  assert.equal((await readScanStatus(db, 'A', job))?.last_progress_at, 1000)
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, 1, 'llm.anthropic', 0.08, ?, ?, NULL, ?, ?)"
  await db.run(ins, ['c1', 'A', job, 0.01, 'settled', 1005, 1008])
  await db.run(ins, ['c2', 'A', job, null, 'reserved', 1012, null])
  assert.equal(await readLastActivity(db, 'A', job), 1012)
  assert.equal((await readScanStatus(db, 'A', job))?.last_progress_at, 1012)
  await db.run('UPDATE scan_spend_calls SET status = ?, actual_usd = 0.02, settled_at = 1020 WHERE id = ?', ['settled', 'c2'])
  assert.equal((await readScanStatus(db, 'A', job))?.last_progress_at, 1020)
  // another tenant's calls on the same job id are never read
  assert.equal(await readLastActivity(db, 'B', job), null)
})

bothEngines('1157-F1: a retry claimed after an older attempt\'s settled call reports the new claim, not the old call', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'software', location: 'Bangalore' }, '{}')
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000, attempts = 1 WHERE id = ?", [job])
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, 1, 'llm.anthropic', 0.08, 0.01, 'settled', NULL, ?, ?)"
  await db.run(ins, ['r1', 'A', job, 1005, 1008])
  // attempt 2 claimed later, no call yet
  await db.run("UPDATE scan_jobs SET claimed_at = 2000, attempts = 2 WHERE id = ?", [job])
  assert.equal((await readScanStatus(db, 'A', job))?.last_progress_at, 2000)
  assert.equal(lastActivityNote(2010, 2000)!.quiet, false)
  // a call in attempt 2 after the claim wins again
  await db.run(ins, ['r2', 'A', job, 2050, 2052])
  assert.equal((await readScanStatus(db, 'A', job))?.last_progress_at, 2052)
})

test('lastActivityNote: recent activity is named, a quiet scan says so and that a stuck one is retried', () => {
  assert.equal(lastActivityNote(1000, null), null)
  assert.equal(lastActivityNote(1000, undefined), null)
  assert.deepEqual(lastActivityNote(1012, 1000), { text: 'Last activity 12 s ago', quiet: false })
  assert.deepEqual(lastActivityNote(1075, 1000), { text: 'Last activity 1 min ago', quiet: false })
  const q = lastActivityNote(1000 + QUIET_AFTER_S, 1000)!
  assert.equal(q.quiet, true); assert.match(q.text, /^No new activity for 1 min\./)
  // 1157-F2: never promise an automatic retry or a time window the server may refuse (hard-kill, MAX_ATTEMPTS, overrides)
  assert.doesNotMatch(q.text, /retried automatically|within a few minutes/)
  assert.match(q.text, /retry it or stop it and tell you what happened/)
  assert.equal(lastActivityNote(1000 + 600, 1000)!.text.startsWith('No new activity for 10 min.'), true)
  assert.deepEqual(lastActivityNote(990, 1000), { text: 'Last activity 0 s ago', quiet: false })   // clock skew never goes negative
})

test('the running page reads last_progress_at and shows the quiet note', () => {
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(page, /setLastProgressAt\(typeof s\.last_progress_at === 'number'/)
  assert.match(page, /data-testid="scan-quiet"/)
  assert.match(page, /lastActivityNote\(now, lastProgressAt\)/)
})
