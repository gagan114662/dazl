// Result classification at the tick boundary (#447 review): runFollowups and runSequences report ordinary refusals as a
// `stopped` result, not an exception, so the tick must classify what came back before it records progress.
//   success  work was done, or there was genuinely nothing due
//   hold     a legitimate configuration or idle state (autopilot off, paused, cap reached, nothing sendable)
//   failure  an operational refusal or failure (reading not enabled with active work, operator switch off, Gmail, uncertain send)
// The table here is the one in docs/SCHEDULER.md. The progress-row semantics run on both engines; the real tick route is
// test/scheduler-tick-outcomes.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { readFileSync } from 'node:fs'
import { classifySync, classifyWork, finishRun, recordProgress, schedulerHealth, startRun, tenantFreshness, BLOCKED_AFTER_FAILURES, FAILURE_REASONS, HOLD_REASONS, type Outcome } from '../lib/ops/scheduler-runs.ts'

type Work = { started?: number; sent: number; skipped: number; stopped?: string }
const idle = (stopped?: string): Work => ({ sent: 0, skipped: 0, ...(stopped ? { stopped } : {}) })
const seqIdle = (stopped?: string): Work => ({ started: 0, ...idle(stopped) })
const out = (o: Outcome) => o.outcome === 'hold' ? `hold:${o.reason}` : o.outcome === 'failure' ? `failure:${o.error instanceof Error ? o.error.message : String(o.error)}` : 'success'

// [worker, returned result, recorded outcome]
const MATRIX: [string, Work, string][] = [
  // runFollowups
  ['followups', idle(), 'success'],                                                   // idle pass: no thread due
  ['followups', { sent: 2, skipped: 1 }, 'success'],                                  // actual progress
  ['followups', idle('not_available'), 'failure:not_available'],                      // operator switch off / kill switch while tenants have work
  ['followups', idle('autopilot_off'), 'hold:autopilot_off'],                         // tenant's autopilot off, paused or consent not current
  ['followups', idle('followups_off'), 'hold:followups_off'],
  ['followups', idle('paused'), 'hold:paused'],                                       // paused or switched off between threads
  ['followups', idle('daily_cap'), 'hold:daily_cap'],                                 // cap wait with nothing sent this tick
  ['followups', { sent: 1, skipped: 0, stopped: 'daily_cap' }, 'success'],            // cap reached after work was done
  ['followups', idle('uncertain_send'), 'failure:uncertain_send'],
  ['followups', { sent: 1, skipped: 0, stopped: 'uncertain_send' }, 'failure:uncertain_send'], // a send of unknown outcome outranks earlier progress
  ['followups', idle('gmail_or_identity'), 'failure:gmail_or_identity'],
  ['followups', idle('gmail_unavailable'), 'failure:gmail_unavailable'],
  // runSequences
  ['sequences', seqIdle(), 'success'],                                                // idle pass: no step due
  ['sequences', { started: 1, sent: 0, skipped: 0 }, 'success'],                      // activation is progress
  ['sequences', { started: 0, sent: 1, skipped: 0 }, 'success'],
  ['sequences', { started: 0, sent: 0, skipped: 3 }, 'success'],                      // skips are per-lead decisions, not failures
  ['sequences', seqIdle('paused'), 'hold:paused'],
  ['sequences', seqIdle('daily_cap'), 'hold:daily_cap'],
  ['sequences', { started: 1, sent: 0, skipped: 0, stopped: 'daily_cap' }, 'success'],
  ['sequences', seqIdle('changed_since_approval'), 'hold:changed_since_approval'],    // approval no longer stands: the tenant's own edit
  ['sequences', seqIdle('sequences_disabled'), 'failure:sequences_disabled'],         // operator switch off / kill switch
  ['sequences', seqIdle('reading_not_enabled'), 'failure:reading_not_enabled'],       // active work, replies cannot be read
  ['sequences', seqIdle('gmail_unavailable'), 'failure:gmail_unavailable'],
  ['sequences', seqIdle('reply_sync_failed'), 'failure:reply_sync_failed'],
  ['sequences', seqIdle('uncertain_send'), 'failure:uncertain_send'],
  ['sequences', seqIdle('gmail_or_identity'), 'failure:gmail_or_identity'],
  // a stop reason the tick does not know is never read as progress
  ['sequences', seqIdle('something_new'), 'failure:something_new'],
  ['followups', { sent: 1, skipped: 0, stopped: 'something_new' }, 'failure:something_new'],
]

test('classification table: every worker result maps to success, hold or failure', () => {
  for (const [worker, r, want] of MATRIX) assert.equal(out(classifyWork(r)), want, `${worker} ${JSON.stringify(r)}`)
  // syncReplies reports errors, never a hold: without reply reading the tenant's follow-up work cannot run
  assert.equal(out(classifySync({})), 'success')
  for (const error of ['reading_not_enabled', 'gmail_unavailable', 'reply_sync_failed']) assert.equal(out(classifySync({ error })), `failure:${error}`)
})

// Every stop reason the workers' source can return is in the table above and named in one of the two sets, so a new
// reason has to be classified deliberately (an unnamed one is a failure either way).
test('the table covers every stop reason runFollowups and runSequences return', () => {
  const known = new Set([...HOLD_REASONS, ...FAILURE_REASONS])
  const inTable = new Set(MATRIX.map(([, r]) => r.stopped).filter((x): x is string => !!x && x !== 'something_new'))
  for (const file of ['followups.ts', 'sequences.ts']) {
    const src = readFileSync(new URL(`../lib/outreach/${file}`, import.meta.url), 'utf8')
    const reasons = [...src.matchAll(/\bstop\('([a-z_]+)'\)/g)].map(m => m[1])
    assert.ok(reasons.length >= 5, `${file}: stop reasons found`)
    for (const r of reasons) { assert.ok(known.has(r), `${file}: stop('${r}') is not classified`); assert.ok(inTable.has(r), `${file}: stop('${r}') is not in the table`) }
  }
  // runSequences also returns syncReplies' error as its stop reason
  for (const r of ['reading_not_enabled', 'gmail_unavailable', 'reply_sync_failed']) assert.ok(FAILURE_REASONS.has(r) && inTable.has(r), r)
  for (const r of HOLD_REASONS) assert.ok(!FAILURE_REASONS.has(r), `${r} in both sets`)
})

const N = 1_900_000_000
const lease = { owner: 'o', generation: 2 }
type Row = { last_attempt_at: number; last_success_at: number | null; last_error: string | null; last_outcome: string; last_hold: string | null; consecutive_failures: number; last_run_id: string }
const row = async (db: Db, t: string, kind: string) => {
  const r = await db.get<Row>('SELECT last_attempt_at, last_success_at, last_error, last_outcome, last_hold, consecutive_failures, last_run_id FROM scheduler_progress WHERE tenant_id = ? AND kind = ?', [t, kind])
  assert.ok(r, `${t}/${kind} row`)
  return { ...r, last_attempt_at: Number(r.last_attempt_at), last_success_at: r.last_success_at == null ? null : Number(r.last_success_at), consecutive_failures: Number(r.consecutive_failures) }
}
const runRow = async (db: Db, id: string) => { const r = await db.get<{ tenants_attempted: number; tenants_failed: number }>('SELECT tenants_attempted, tenants_failed FROM scheduler_runs WHERE id = ?', [id]); return { attempted: Number(r!.tenants_attempted), failed: Number(r!.tenants_failed) } }
const success: Outcome = { outcome: 'success' }
const hold = (reason: string): Outcome => ({ outcome: 'hold', reason })
const failure = (why: string): Outcome => ({ outcome: 'failure', error: new Error(why) })

bothEngines('progress rows: a hold keeps the success time and the failure count; failures block; success clears', async ({ db }) => {
  const r1 = await startRun(db, lease, N)
  await recordProgress(db, r1, 'A', 'sequences', success, N)
  assert.deepEqual(await row(db, 'A', 'sequences'), { last_attempt_at: N, last_success_at: N, last_error: null, last_outcome: 'success', last_hold: null, consecutive_failures: 0, last_run_id: r1 })
  // repeated failure: the count climbs, the last success stays, the tenant blocks
  for (let i = 1; i <= BLOCKED_AFTER_FAILURES; i++) await recordProgress(db, r1, 'A', 'sequences', failure('reading_not_enabled'), N + i)
  let a = await row(db, 'A', 'sequences')
  assert.equal(a.consecutive_failures, BLOCKED_AFTER_FAILURES); assert.equal(a.last_success_at, N); assert.equal(a.last_error, 'Error: reading_not_enabled'); assert.equal(a.last_outcome, 'failure')
  assert.equal((await tenantFreshness(db, 'A', N + 10)).state, 'blocked')
  // a hold is recorded as an attempt with its reason; it neither counts as a failure nor resolves the earlier ones
  const r2 = await startRun(db, lease, N + 20)
  await recordProgress(db, r2, 'A', 'sequences', hold('paused'), N + 20)
  a = await row(db, 'A', 'sequences')
  assert.deepEqual(a, { last_attempt_at: N + 20, last_success_at: N, last_error: 'Error: reading_not_enabled', last_outcome: 'hold', last_hold: 'paused', consecutive_failures: BLOCKED_AFTER_FAILURES, last_run_id: r2 })
  assert.deepEqual(await runRow(db, r2), { attempted: 1, failed: 0 }, 'a held tenant is attempted, not failed')
  const held = await tenantFreshness(db, 'A', N + 30)
  assert.equal(held.state, 'blocked', 'pausing does not resolve the failures'); assert.deepEqual(held.holds, ['sequences:paused'])
  // a failure after the hold continues the count: holds do not reset it
  await recordProgress(db, r2, 'A', 'sequences', failure('reading_not_enabled'), N + 40)
  a = await row(db, 'A', 'sequences')
  assert.equal(a.consecutive_failures, BLOCKED_AFTER_FAILURES + 1); assert.equal(a.last_hold, null); assert.equal(a.last_outcome, 'failure')
  assert.deepEqual(await runRow(db, r2), { attempted: 1, failed: 1 })
  // success clears everything
  await recordProgress(db, r2, 'A', 'sequences', success, N + 50)
  assert.deepEqual(await row(db, 'A', 'sequences'), { last_attempt_at: N + 50, last_success_at: N + 50, last_error: null, last_outcome: 'success', last_hold: null, consecutive_failures: 0, last_run_id: r2 })
  await finishRun(db, r2, 'ok', undefined, N + 60)
  const f = await tenantFreshness(db, 'A', N + 70)
  assert.equal(f.state, 'healthy'); assert.deepEqual(f.holds, [])
  assert.deepEqual(await runRow(db, r2), { attempted: 1, failed: 0 })
})

bothEngines('a tenant that has only ever been held is held, not healthy and not failing; the operator sees counts only', async ({ db }) => {
  const r = await startRun(db, lease, N)
  await recordProgress(db, r, 'B', 'reply_sync', success, N)
  await recordProgress(db, r, 'B', 'followups', hold('autopilot_off'), N)
  await recordProgress(db, r, 'C', 'sequences', hold('daily_cap'), N)
  await recordProgress(db, r, 'D', 'sequences', success, N)
  await finishRun(db, r, 'ok', undefined, N + 5)
  assert.deepEqual(await row(db, 'B', 'followups'), { last_attempt_at: N, last_success_at: null, last_error: null, last_outcome: 'hold', last_hold: 'autopilot_off', consecutive_failures: 0, last_run_id: r })
  const b = await tenantFreshness(db, 'B', N + 10)
  assert.equal(b.state, 'held'); assert.deepEqual(b.holds, ['followups:autopilot_off']); assert.deepEqual(b.reasons, [])
  assert.deepEqual(b.work.map(w => [w.kind, w.last_outcome, w.last_hold]), [['followups', 'hold', 'autopilot_off'], ['reply_sync', 'success', null]])
  assert.equal((await tenantFreshness(db, 'C', N + 10)).state, 'held')
  assert.equal((await tenantFreshness(db, 'D', N + 10)).state, 'healthy')
  const h = await schedulerHealth(db, N + 10)
  assert.equal(h.ok, true, 'a hold is not a problem'); assert.deepEqual(h.problems, [])
  assert.deepEqual(h.tenants, { tracked: 3, blocked: 0, held: 2, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null })
  for (const leak of ['"B"', '"C"', 'autopilot_off', 'daily_cap']) assert.ok(!JSON.stringify(h).includes(leak), leak)
  // a hold does not wake a reply-sync staleness check either: the kind keeps its own last attempt and success
  assert.equal((await tenantFreshness(db, 'B', N + 10)).reasons.includes('reply_sync_stale'), false)
})

bothEngines('cross-tenant isolation: one tenant\'s failures, holds and recovery never touch another\'s rows', async ({ db }) => {
  const r = await startRun(db, lease, N)
  await recordProgress(db, 'r0', 'A', 'sequences', success, N - 100)
  await recordProgress(db, 'r0', 'B', 'sequences', success, N - 100)
  for (let i = 0; i < BLOCKED_AFTER_FAILURES; i++) await recordProgress(db, r, 'A', 'sequences', failure('uncertain_send'), N + i)
  await recordProgress(db, r, 'B', 'sequences', hold('paused'), N)
  const b = await row(db, 'B', 'sequences')
  assert.equal(b.consecutive_failures, 0); assert.equal(b.last_error, null); assert.equal(b.last_success_at, N - 100)
  await recordProgress(db, r, 'B', 'sequences', success, N + 5)
  const a = await row(db, 'A', 'sequences')
  assert.equal(a.consecutive_failures, BLOCKED_AFTER_FAILURES); assert.equal(a.last_success_at, N - 100); assert.equal(a.last_outcome, 'failure')
  assert.deepEqual(await runRow(db, r), { attempted: 2, failed: 1 })
  await finishRun(db, r, 'partial', undefined, N + 10)
  const h = await schedulerHealth(db, N + 20)
  assert.equal(h.tenants.blocked, 1); assert.equal(h.tenants.held, 0); assert.equal(h.ok, false)
  assert.deepEqual(h.problems, ['1 tenant(s) blocked by repeated failures'])
  assert.equal((await tenantFreshness(db, 'B', N + 20)).state, 'healthy')
})
