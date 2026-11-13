// #1042: a new account's first play repeats by itself. Owner scope (Gagan via Quest, 2026-11-11 11:48): the first play
// repeats automatically, every run under the existing caps, and an email lists the new leads after each scheduled run
// (lib/play-mail.ts). Cadence: DAILY on every plan (decision by Hermes, delegated by Gagan, 2026-11-12), with the free
// plan's daily cap (1 scan a day, $0.30 a run) in lib/play-cadence.ts.
//
// What counts as the first play: the account's earliest query scan that finished 'done' (a failed or cancelled first
// try does not count; a CSV import never does). Within FIRST_PLAY_WINDOW_S of it finishing, if the account has no saved
// play at all (no watch, no monitor), the scheduler tick (app/api/internal/tick) creates ONE daily watch for it:
//   - the play's own sentence and the profile the run actually used (scan_jobs.icp after the run), its per-run budget;
//   - its first scheduled run one day after the first play finished (REPEAT_INTERVAL_S), so "next search tomorrow";
//   - the first play's leads are remembered by the watch (lib/watch.ts watchLeadsStep), so the next run marks only
//     companies the account has not been shown as new;
//   - the first play's job is linked to the watch (scan_jobs.watch_id). That link is the once-only marker: a repeat the
//     person deletes or pauses is never created again, and it is how lib/play-funding.ts tells this repeat apart from a
//     watch someone made by hand (its only job older than the watch).
// Daily on every plan: the repeat runs every day (lib/play-cadence.ts watchIntervalS); a watch made by hand stays weekly.
// Existing accounts are not enrolled on deploy: only a first play that finished within the window qualifies. A repeat
// created weekly before this change is pulled in to a day after its last run by the scheduler (lib/watch.ts
// pullInWeeklyRepeats); its cadence is read, not stored.
// Each account's writes are one transaction, fenced by the tick's lease and ordered with create/resume of a watch by
// the same per-tenant lock (lib/watch.ts activationCheck): the "no saved play yet" check and the insert cannot interleave
// with the person saving a play by hand. Nothing here runs a scan or spends anything; the runs are the scheduler's.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from './db/client.ts'
import { watchLeadsStep, type Fence } from './watch.ts'
import { normalizeIcp } from './scan/icp.ts'
import { LeaseLost, StaleLeaseWrite } from './shared/lease.ts'
import { captureError } from './ops/errors.ts'
import { DAY_S } from './play-cadence.ts'

export const FIRST_PLAY_WINDOW_S = 2 * 86400
export const REPEAT_INTERVAL_S = DAY_S
const BATCH = 200
const nowS = () => Math.floor(Date.now() / 1000)
const noFence: Fence = function* () { /* not fenced */ }

const FIRST_DONE = `j.status = 'done' AND j.query IS NOT NULL AND j.csv_domain IS NULL`
const CANDIDATES_SQL = `SELECT j.id, j.user_id, j.query, j.icp, j.run_budget, j.created_at, j.finished_at FROM scan_jobs j
  WHERE ${FIRST_DONE} AND j.watch_id IS NULL AND j.finished_at >= ?
    AND NOT EXISTS (SELECT 1 FROM scan_jobs e WHERE e.user_id = j.user_id AND e.id <> j.id AND e.status = 'done' AND e.query IS NOT NULL AND e.csv_domain IS NULL
      AND (e.created_at < j.created_at OR (e.created_at = j.created_at AND e.insert_seq < j.insert_seq)))
    AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.user_id = j.user_id)
    AND NOT EXISTS (SELECT 1 FROM monitors m WHERE m.user_id = j.user_id)
  ORDER BY j.finished_at, j.id LIMIT ${BATCH}`
type Candidate = { id: string; user_id: string; query: string; icp: string | null; run_budget: string | null; created_at: number; finished_at: number }

// The repeat's first run: the next time of day the first play finished at, at least a minute from now. A tick that
// creates the repeat late (the window is FIRST_PLAY_WINDOW_S, longer than a day) keeps that time of day, never "now".
export function firstRepeatAt(finishedAt: number, now: number): number {
  let next = finishedAt + Math.max(1, Math.ceil((now - finishedAt) / REPEAT_INTERVAL_S)) * REPEAT_INTERVAL_S
  while (next < now + 60) next += REPEAT_INTERVAL_S
  return next
}

// The profile the repeat runs with: the one the first run used, normalized exactly as "Watch this weekly" normalizes it
// (app/api/watch/route.ts). A run with no usable profile gets no repeat (the runner would infer a different one).
export function repeatIcp(raw: string | null): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  try { const icp = normalizeIcp(JSON.parse(raw)); return icp ? JSON.stringify(icp) : null } catch { return null }
}

function* createRepeat(t: Tx, c: Candidate, now: number, fence: Fence): TxBody<string | null> {
  yield* fence(t)
  if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('watch_activate:' || ?, 0)) AS x", [c.user_id])
  // re-read under the lock: the person may have saved a play, or another tick created the repeat, in between
  if (yield* t.get('SELECT 1 AS x FROM watches WHERE user_id = ? LIMIT 1', [c.user_id])) return null
  if (yield* t.get('SELECT 1 AS x FROM monitors WHERE user_id = ? LIMIT 1', [c.user_id])) return null
  const icp = repeatIcp(c.icp)
  const query = typeof c.query === 'string' ? c.query.trim().slice(0, 600) : ''
  if (!icp || query.length < 3) return null
  const id = randomBytes(12).toString('hex')
  const link = yield* t.run("UPDATE scan_jobs SET watch_id = ? WHERE id = ? AND user_id = ? AND watch_id IS NULL AND status = 'done'", [id, c.id, c.user_id])
  if (link.changes !== 1) return null
  const next = firstRepeatAt(Number(c.finished_at), now)
  yield* t.run('INSERT INTO watches (id, user_id, query, icp, next_run_at, last_run_at, run_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, c.user_id, query, icp, next, Number(c.created_at), c.run_budget ?? null, now])
  yield* watchLeadsStep(t, id, c.id)
  return id
}

// Returns the watches created. One account's failure is recorded and skipped; a lost lease stops the whole pass.
export async function repeatFirstPlays(db: Db, o: { now?: number; fence?: Fence } = {}): Promise<string[]> {
  const now = o.now ?? nowS(), fence = o.fence ?? noFence
  const rows = await db.all<Candidate>(CANDIDATES_SQL, [now - FIRST_PLAY_WINDOW_S])
  const made: string[] = []
  for (const c of rows) {
    try {
      const id = await db.tx(t => createRepeat(t, c, now, fence))
      if (id) made.push(id)
    } catch (e) {
      if (e instanceof LeaseLost || e instanceof StaleLeaseWrite) throw e
      captureError(e, { source: 'worker', where: 'play-repeat:first-play', tenantId: c.user_id })
    }
  }
  return made
}
