// Scheduler heartbeat and progress (issue #361). The tick (app/api/internal/tick/route.ts) records, durably:
//   - every run: start, finish, status, the lease owner and generation it ran under, tenants attempted and failed;
//   - per tenant and kind of work (reply_sync, followups, sequences): last attempt, last success, the last failure
//     reason (an error class and short message, scrubbed: never a body or a token), consecutive failures, and the
//     outcome of the last attempt: success, hold (with its reason) or failure.
// The workers report ordinary refusals as a result (`stopped`), not an exception, so the tick classifies what came
// back (classifyWork, classifySync) before recording it:
//   success  work was done, or there was genuinely nothing due;
//   hold     a legitimate configuration or idle state (the tenant's autopilot off or paused, the daily cap reached,
//            an approval that no longer stands): the attempt and its reason are recorded, the last success and the
//            failure count are left as they were;
//   failure  an operational refusal or failure (reply reading not enabled while there is active work, the operator
//            switch off while tenants have work, Gmail, an uncertain send): the count climbs, the last success stays.
// From that, schedulerFreshness() says whether the scheduler is actually making progress, separately from whether it is
// configured (lib/outreach/scheduler-readiness.ts is configuration only): a scheduler can be configured on and stale.
//   never_ran  no run recorded            running  a run in progress, younger than the lease TTL
//   fresh      last completed run recent  stale    last completed run older than STALE_AFTER_S (cron off or failing)
//   crashed    a run started more than CRASHED_AFTER_S ago and never finished (process died inside a tick)
// Separately from that state: unresolved_failure, when the latest finished run failed or lost its lease and no run has
// succeeded since. An earlier success that is still recent is evidence of freshness, not that the newer tick worked, so
// this is a health problem (and an alert) until a newer run completes ok or partial.
// Per tenant: reply sync stale (no success for REPLY_SYNC_STALE_S while it is being attempted), blocked
// (BLOCKED_AFTER_FAILURES consecutive failures), and due work overdue (the oldest due sequence step more than
// OVERDUE_ALERT_S past its due time). The operator view is counts only; a tenant sees only its own rows.
// Queries are on the Db layer (SQLite today, Postgres after the cutover: lib/db/migrations/pg/0019_scheduler_runs.sql).
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { asDb, type DbLike } from '../db/client.ts'
import { GAPS_S, TEST_GAPS_S } from '../outreach/sequences.ts'

// Thresholds (docs/SCHEDULER.md). The tick is expected every 15 minutes.
export const TICK_EVERY_S = 15 * 60
export const STALE_AFTER_S = 3 * TICK_EVERY_S        // three missed ticks
export const CRASHED_AFTER_S = 30 * 60               // the tick lease TTL: a live run would have finished or renewed
export const REPLY_SYNC_STALE_S = 2 * 60 * 60
export const OVERDUE_ALERT_S = 60 * 60
export const BLOCKED_AFTER_FAILURES = 3
const KEEP_RUNS = 2000

export type Kind = 'reply_sync' | 'followups' | 'sequences' | 'autopilot'
// The kinds of work the tick records per tenant. 'autopilot' (#411, #448): the first-touch drain.
const KINDS = "('reply_sync','followups','sequences','autopilot')"
const PROGRESS_COLUMNS = `
      tenant_id            TEXT NOT NULL,
      kind                 TEXT NOT NULL CHECK (kind IN ${KINDS}),
      last_attempt_at      INTEGER NOT NULL,
      last_success_at      INTEGER,
      last_error           TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
      last_outcome         TEXT NOT NULL DEFAULT 'success' CHECK (last_outcome IN ('success','hold','failure')),
      last_hold            TEXT CHECK (last_hold IS NULL OR length(last_hold) <= 40),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_run_id          TEXT,
      PRIMARY KEY (tenant_id, kind)`
export function migrateSchedulerRuns(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id                TEXT PRIMARY KEY,
      started_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      status            TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed','lease_lost')),
      lease_owner       TEXT NOT NULL,
      lease_generation  INTEGER NOT NULL,
      tenants_attempted INTEGER NOT NULL DEFAULT 0,
      tenants_failed    INTEGER NOT NULL DEFAULT 0,
      error             TEXT CHECK (error IS NULL OR length(error) <= 200)
    );
    CREATE INDEX IF NOT EXISTS scheduler_runs_started ON scheduler_runs (started_at);
    CREATE TABLE IF NOT EXISTS scheduler_progress (${PROGRESS_COLUMNS}
    );
  `)
  // Stores created before the outcome columns existed (earlier heads of #447; never a released schema).
  const cols = new Set((db.prepare('PRAGMA table_info(scheduler_progress)').all() as { name: string }[]).map(c => c.name))
  if (!cols.has('last_outcome')) db.exec("ALTER TABLE scheduler_progress ADD COLUMN last_outcome TEXT NOT NULL DEFAULT 'success' CHECK (last_outcome IN ('success','hold','failure'))")
  if (!cols.has('last_hold')) db.exec('ALTER TABLE scheduler_progress ADD COLUMN last_hold TEXT CHECK (last_hold IS NULL OR length(last_hold) <= 40)')
  // Stores created before the autopilot kind (#448): the kind check is part of the table, so it is rebuilt once, rows kept.
  // Whether the check already allows 'autopilot' is learned from a probe row under a savepoint that is always rolled back
  // (SQLite keeps the check only in the table's SQL text; schema setup, SQLite only). Probe and rebuild are one write
  // transaction (BEGIN IMMEDIATE): two processes starting together take turns, the second finds the check widened. Once
  // per connection: the tick runs this on every request. Postgres: migration 0026 re-creates the constraint.
  if (KIND_CHECKED.has(db)) return
  db.transaction(() => {
    const widened = (() => {
      try { db.exec("SAVEPOINT kind_probe; INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at) VALUES ('', 'autopilot', 0); ROLLBACK TO kind_probe; RELEASE kind_probe"); return true }
      catch (e) { db.exec('ROLLBACK TO kind_probe; RELEASE kind_probe'); if (e instanceof Error && /CHECK constraint failed/.test(e.message)) return false; throw e }
    })()
    if (!widened) db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_progress_v2 (${PROGRESS_COLUMNS}
      );
      INSERT INTO scheduler_progress_v2 SELECT tenant_id, kind, last_attempt_at, last_success_at, last_error, last_outcome, last_hold, consecutive_failures, last_run_id FROM scheduler_progress;
      DROP TABLE scheduler_progress;
      ALTER TABLE scheduler_progress_v2 RENAME TO scheduler_progress;
    `)
  }).immediate()
  KIND_CHECKED.add(db)
}
const KIND_CHECKED = new WeakSet<Database.Database>()

// What the tick records for one tenant and kind of work, from what the worker returned.
export type Outcome = { outcome: 'success' } | { outcome: 'hold'; reason: string } | { outcome: 'failure'; error: unknown }
// Stop reasons runFollowups and runSequences return that are legitimate holds: the tenant's own configuration or an
// idle state, not something failing. Every other stop (and any reason the tick does not know) is a failure: the
// scheduler must never read an unknown refusal as progress.
export const HOLD_REASONS: ReadonlySet<string> = new Set(['autopilot_off', 'followups_off', 'paused', 'daily_cap', 'changed_since_approval'])
export const FAILURE_REASONS: ReadonlySet<string> = new Set(['not_available', 'sequences_disabled', 'reading_not_enabled', 'gmail_unavailable', 'reply_sync_failed', 'uncertain_send', 'gmail_or_identity'])
// The autopilot drain's own holds (lib/outreach/autopilot.ts stop reasons that are the tenant's state, not a failure):
// off or consent to renew (the tenant's switch), Gmail to reconnect or connect (the tenant's mailbox). Its uncertain send,
// unreadable authority, lost reservation and the operator switch are failures, as for the other kinds.
export const DRAIN_HOLD_REASONS: ReadonlySet<string> = new Set([...HOLD_REASONS, 'off', 'consent_required', 'gmail_not_connected', 'gmail_reconnect_needed'])
export function classifyWork(r: { stopped?: string; sent?: number; started?: number }, holds: ReadonlySet<string> = HOLD_REASONS): Outcome {
  if (r.stopped === undefined) return { outcome: 'success' }
  if (holds.has(r.stopped)) return (r.sent ?? 0) > 0 || (r.started ?? 0) > 0 ? { outcome: 'success' } : { outcome: 'hold', reason: r.stopped } // held after work was done: progress
  return { outcome: 'failure', error: new Error(r.stopped || 'unknown_stop') } // an empty reason is as unknown as a new one
}
// syncReplies reports errors, never a hold: without reply reading the tenant's follow-up work cannot run.
export function classifySync(r: { error?: string }): Outcome {
  return r.error ? { outcome: 'failure', error: new Error(r.error) } : { outcome: 'success' }
}

// A failure reason safe to store and show: the error's class and the first line of its message, without anything that
// looks like an address, token or URL query, capped.
export function failureReason(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error'
  const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0]
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').replace(/\b(Bearer|token|key|secret)\b\S*\s*\S*/gi, '<redacted>').replace(/\?\S*/g, '?…')
  return `${name}: ${msg}`.slice(0, 200)
}

const nowS = () => Math.floor(Date.now() / 1000)
export async function startRun(d: DbLike, lease: { owner: string; generation: number }, now = nowS()): Promise<string> {
  const db = asDb(d), id = randomBytes(12).toString('hex')
  await db.run("INSERT INTO scheduler_runs (id, started_at, status, lease_owner, lease_generation) VALUES (?, ?, 'running', ?, ?)", [id, now, lease.owner, lease.generation])
  const cut = await db.get<{ started_at: number }>('SELECT started_at FROM scheduler_runs ORDER BY started_at DESC LIMIT 1 OFFSET ?', [KEEP_RUNS])
  if (cut) await db.run('DELETE FROM scheduler_runs WHERE started_at <= ?', [cut.started_at])
  return id
}
export async function recordProgress(d: DbLike, runId: string, tenantId: string, kind: Kind, o: Outcome, now = nowS()): Promise<void> {
  const db = asDb(d), err = o.outcome === 'failure' ? failureReason(o.error) : null, held = o.outcome === 'hold' ? o.reason.slice(0, 40) : null
  // success: the success time moves and the failure state clears; failure: the count climbs, the last success stays;
  // hold: only the attempt, the outcome and its reason move.
  await db.run(`INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, last_error, last_outcome, last_hold, consecutive_failures, last_run_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, kind) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
                last_success_at = COALESCE(excluded.last_success_at, scheduler_progress.last_success_at),
                last_error = CASE excluded.last_outcome WHEN 'hold' THEN scheduler_progress.last_error ELSE excluded.last_error END,
                last_outcome = excluded.last_outcome,
                last_hold = excluded.last_hold,
                consecutive_failures = CASE excluded.last_outcome WHEN 'success' THEN 0 WHEN 'hold' THEN scheduler_progress.consecutive_failures ELSE scheduler_progress.consecutive_failures + 1 END,
                last_run_id = excluded.last_run_id`,
    [tenantId, kind, now, o.outcome === 'success' ? now : null, err, o.outcome, held, o.outcome === 'failure' ? 1 : 0, runId])
  await db.run(`UPDATE scheduler_runs SET tenants_attempted = (SELECT count(DISTINCT tenant_id) FROM scheduler_progress WHERE last_run_id = ?),
              tenants_failed = (SELECT count(DISTINCT tenant_id) FROM scheduler_progress WHERE last_run_id = ? AND last_outcome = 'failure') WHERE id = ?`, [runId, runId, runId])
}
export async function finishRun(d: DbLike, runId: string, status: 'ok' | 'partial' | 'failed' | 'lease_lost', error?: unknown, now = nowS()): Promise<void> {
  await asDb(d).run("UPDATE scheduler_runs SET finished_at = ?, status = ?, error = ? WHERE id = ? AND status = 'running'", [now, status, error === undefined ? null : failureReason(error), runId])
}

type RunRow = { id: string; started_at: number; finished_at: number | null; status: string; lease_generation: number; error: string | null }
export type OperationalState = 'never_ran' | 'running' | 'fresh' | 'stale' | 'crashed'
export interface Operational {
  state: OperationalState
  last_started_at: number | null
  last_completed_at: number | null
  last_completed_status: string | null
  last_completed_age_s: number | null
  running_since: number | null
  lease_generation: number | null
  last_error: string | null
  unresolved_failure: { status: 'failed' | 'lease_lost'; finished_at: number } | null
}
const n = (v: unknown) => v === null || v === undefined ? null : Number(v)

export async function operational(d: DbLike, now = nowS()): Promise<Operational> {
  const db = asDb(d)
  const empty: Operational = { state: 'never_ran', last_started_at: null, last_completed_at: null, last_completed_status: null, last_completed_age_s: null, running_since: null, lease_generation: null, last_error: null, unresolved_failure: null }
  const last = await db.get<RunRow>('SELECT id, started_at, finished_at, status, lease_generation, error FROM scheduler_runs ORDER BY started_at DESC, id DESC LIMIT 1')
  if (!last) return empty
  const done = await db.get<RunRow>("SELECT id, started_at, finished_at, status, lease_generation, error FROM scheduler_runs WHERE finished_at IS NOT NULL AND status IN ('ok','partial') ORDER BY finished_at DESC LIMIT 1")
  const started = n(last.started_at)!, finished = n(done?.finished_at)
  const latest = await db.get<RunRow>("SELECT id, started_at, finished_at, status, lease_generation, error FROM scheduler_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, started_at DESC, id DESC LIMIT 1")
  const out: Operational = {
    ...empty,
    unresolved_failure: latest && (latest.status === 'failed' || latest.status === 'lease_lost') ? { status: latest.status, finished_at: n(latest.finished_at)! } : null, last_started_at: started, lease_generation: n(last.lease_generation),
    last_completed_at: finished, last_completed_status: done?.status ?? null, last_completed_age_s: finished !== null ? now - finished : null,
    last_error: last.error ?? (last.status === 'failed' || last.status === 'lease_lost' ? last.status : null),
  }
  const recent = finished !== null && now - finished <= STALE_AFTER_S
  if (last.status === 'running') {
    out.running_since = started
    if (now - started > CRASHED_AFTER_S) return { ...out, state: 'crashed' }
    return { ...out, state: recent ? 'running' : 'stale' } // a live run is fresh only if the previous completion is recent
  }
  return { ...out, state: recent ? 'fresh' : 'stale' }
}

// The oldest due sequence step for one tenant (approved or active sequences, step 1 sent, next step not yet sent). Test
// inboxes (sequence_settings.test_addresses) use the minute gaps, as runSequences does.
export async function oldestDue(d: DbLike, tenantId: string, now = nowS()): Promise<{ due_at: number; overdue_s: number } | null> {
  const db = asDb(d)
  const rows = await db.all<{ to_email: string; step1_sent: number; steps_sent: number }>(`SELECT s.to_email, m.sent_at AS step1_sent,
      (SELECT count(*) FROM sequence_steps st WHERE st.tenant_id = s.tenant_id AND st.sequence_id = s.id AND st.step > 1 AND st.status = 'sent') + 1 AS steps_sent
    FROM sequences s JOIN outreach_messages m ON m.id = s.message_id AND m.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.status IN ('approved','active') AND m.status = 'sent' AND m.sent_at IS NOT NULL`, [tenantId])
  if (!rows.length) return null
  const set = await db.get<{ test_addresses: string }>('SELECT test_addresses FROM sequence_settings WHERE tenant_id = ?', [tenantId])
  let tests: string[] = []; try { tests = (JSON.parse(set?.test_addresses ?? '[]') as string[]).map(e => e.trim().toLowerCase()) } catch { /* none */ }
  let due: number | null = null
  for (const r of rows) {
    const sent = Number(r.steps_sent)
    if (sent >= GAPS_S.length) continue
    const at = Number(r.step1_sent) + (tests.includes(r.to_email.trim().toLowerCase()) ? TEST_GAPS_S : GAPS_S)[sent]
    if (at <= now && (due === null || at < due)) due = at
  }
  return due === null ? null : { due_at: due, overdue_s: now - due }
}

// held: the last attempt at some kind of work was a hold (the tenant's own configuration or an idle state) and nothing
// is failing or stale: neither progress nor a problem. `holds` names them as kind:reason.
export type TenantState = 'healthy' | 'idle' | 'stale' | 'blocked' | 'held'
export interface TenantFreshness {
  scheduler: OperationalState
  state: TenantState
  reasons: string[]
  holds: string[]
  work: { kind: Kind; last_attempt_at: number; last_success_at: number | null; consecutive_failures: number; last_error: string | null; last_outcome: 'success' | 'hold' | 'failure'; last_hold: string | null }[]
  oldest_due: { due_at: number; overdue_s: number } | null
}
// One tenant's own progress (only its rows are read). For the tenant's UI next to the configuration facts.
export async function tenantFreshness(d: DbLike, tenantId: string, now = nowS(), op?: Operational): Promise<TenantFreshness> {
  const db = asDb(d)
  op ??= await operational(db, now)
  const work = (await db.all<TenantFreshness['work'][number]>('SELECT kind, last_attempt_at, last_success_at, consecutive_failures, last_error, last_outcome, last_hold FROM scheduler_progress WHERE tenant_id = ? ORDER BY kind', [tenantId]))
    .map(w => ({ ...w, last_attempt_at: Number(w.last_attempt_at), last_success_at: n(w.last_success_at), consecutive_failures: Number(w.consecutive_failures), last_hold: w.last_hold ?? null }))
  const due = await oldestDue(db, tenantId, now)
  const reasons: string[] = []
  if ((op.state === 'stale' || op.state === 'crashed' || op.state === 'never_ran') && (work.length || due)) reasons.push(`scheduler_${op.state}`)
  for (const w of work) {
    if (w.consecutive_failures >= BLOCKED_AFTER_FAILURES) reasons.push(`${w.kind}_failing`)
    else if (w.kind === 'reply_sync' && w.last_attempt_at > (w.last_success_at ?? 0) && now - (w.last_success_at ?? w.last_attempt_at) > REPLY_SYNC_STALE_S) reasons.push('reply_sync_stale')
  }
  if (due && due.overdue_s > OVERDUE_ALERT_S) reasons.push('due_work_overdue')
  const holds = work.filter(w => w.last_outcome === 'hold').map(w => `${w.kind}:${w.last_hold ?? 'unknown'}`)
  const state: TenantState = reasons.some(r => r.endsWith('_failing')) ? 'blocked' : reasons.length ? 'stale' : holds.length ? 'held' : work.length || due ? 'healthy' : 'idle'
  return { scheduler: op.state, state, reasons, holds, work, oldest_due: due }
}

// The operator's view: the scheduler's own state and counts across tenants. No tenant id, name or error text.
export interface SchedulerHealth { ok: boolean; operational: Omit<Operational, 'last_error'> & { last_error_class: string | null }; tenants: { tracked: number; blocked: number; held: number; reply_sync_stale: number; overdue: number; oldest_overdue_s: number | null }; problems: string[] }
export async function schedulerHealth(d: DbLike, now = nowS()): Promise<SchedulerHealth> {
  const db = asDb(d)
  const op = await operational(db, now)
  const ids = new Set<string>()
  for (const r of await db.all<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM scheduler_progress')) ids.add(r.tenant_id)
  for (const r of await db.all<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM sequences WHERE status IN ('approved','active')")) ids.add(r.tenant_id)
  let blocked = 0, held = 0, stale = 0, overdue = 0, oldest: number | null = null
  for (const id of ids) {
    const f = await tenantFreshness(db, id, now, op)
    if (f.state === 'blocked') blocked++
    if (f.state === 'held') held++ // not a problem: the tenant's own hold
    if (f.reasons.includes('reply_sync_stale')) stale++
    if (f.reasons.includes('due_work_overdue')) { overdue++; oldest = Math.max(oldest ?? 0, f.oldest_due!.overdue_s) }
  }
  const problems: string[] = []
  if (op.state === 'stale' || op.state === 'crashed') problems.push(`scheduler ${op.state}${op.last_completed_age_s != null ? `: last completed run ${op.last_completed_age_s}s ago` : ': no completed run'}`)
  if (op.unresolved_failure) problems.push(`latest scheduler run ${op.unresolved_failure.status}: no successful run since`)
  if (op.state === 'never_ran' && ids.size) problems.push('scheduler never ran, but tenants have scheduled work')
  if (blocked) problems.push(`${blocked} tenant(s) blocked by repeated failures`)
  if (stale) problems.push(`${stale} tenant(s) with stale reply sync`)
  if (overdue) problems.push(`${overdue} tenant(s) with due work overdue by more than ${OVERDUE_ALERT_S}s (oldest ${oldest}s)`)
  const { last_error, ...rest } = op
  return { ok: problems.length === 0, operational: { ...rest, last_error_class: last_error ? last_error.split(':')[0] : null }, tenants: { tracked: ids.size, blocked, held, reply_sync_stale: stale, overdue, oldest_overdue_s: oldest }, problems }
}

// /api/health/scheduler's response: 200 when there is no problem, 503 otherwise; never cached.
// A store whose scheduler tables were never created (no tick has run in this process and nothing migrated it) reads as
// never ran, not as an error.
export async function schedulerHealthResponse(d: DbLike, now = nowS()): Promise<Response> {
  let h: SchedulerHealth
  try { h = await schedulerHealth(d, now) }
  catch (e) {
    if (!/no such table|does not exist/i.test(e instanceof Error ? e.message : '')) throw e
    h = { ok: true, operational: { state: 'never_ran', last_started_at: null, last_completed_at: null, last_completed_status: null, last_completed_age_s: null, running_since: null, lease_generation: null, last_error_class: null, unresolved_failure: null }, tenants: { tracked: 0, blocked: 0, held: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null }, problems: [] }
  }
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
