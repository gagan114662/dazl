// Watch scans: a saved query + ICP re-run weekly (#1042: the repeat dazl creates for a new account's first play re-runs
// daily, with the free plan's daily cap, lib/play-cadence.ts). Design approved by the repo owner on 2026-10-21:
// - every run counts against the monthly scan quota
// - never trial-funded: a watch with no user key pauses, it never touches the operator key
// - max 3 active watches per user
// - "new" = the lead's company domain (or normalized name) was not seen by this watch before
// - results surface in-app only
// On the Db layer (SQLite or Postgres), except markWatchLeads: the scan runner still calls it on the raw handle.
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'
import { randomBytes } from 'node:crypto'
import { countActiveJobs, countActiveJobsStep, queryJobStep } from './scan/store-db.ts'
import { readHasKey } from './llm/key-store.ts'
import { readScanQuota } from './plans.ts'
import { scheduledPlayOffer } from './scan/play-offer.ts'
import { admitTrialRun, isFirstPlayRepeat, isFirstPlayRepeatStep, lockScanAdmission, markTrialJobStep, releaseTrialRun, trialFunder, trialPauseReason, type TrialRun } from './play-funding.ts'
import { cappedRunBudget, freeCapApplies, FREE_DAILY_RUNS, scansTodayStep, skipNotice, skipWatchRunStep, watchIntervalS, WEEK_S } from './play-cadence.ts'

export const MAX_WATCHES = 3

export function migrateWatch(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS watches (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    query       TEXT NOT NULL,
    icp         TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    paused_reason TEXT,
    created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`)
  // Optional per-run budget (lib/scan/run-budget.ts), applied to EACH weekly run's job. It bounds one run, not the watch in total.
  if (!(db.prepare('PRAGMA table_info(watches)').all() as { name: string }[]).some(c => c.name === 'run_budget')) db.exec('ALTER TABLE watches ADD COLUMN run_budget TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS watches_due ON watches (active, next_run_at)')
  db.exec(`CREATE TABLE IF NOT EXISTS watch_seen (
    watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    seen_key   TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (watch_id, seen_key)
  )`)
}

export interface Watch { run_budget?: string | null; id: string; user_id: string; query: string; icp: string; active: number; next_run_at: number; last_run_at: number | null; paused_reason: string | null; created_at: number }

const nowS = () => Math.floor(Date.now() / 1000)

export type WatchRefusal = { error: string; code: 'watch_limit' | 'watch_duplicate' }
const LIMIT_MSG = `You already have ${MAX_WATCHES} active weekly watches. Pause or delete one first.`
const DUPE_MSG = 'You are already watching that search.'

// The one activation check (#905), used by create and resume: run inside the transaction that activates the watch.
// On Postgres a per-tenant advisory lock orders concurrent creates/resumes (and runs across instances); SQLite's tx is
// synchronous from BEGIN to COMMIT, so the check and the write cannot interleave with another request.
function* activationCheck(t: Tx, userId: string, query: string, exceptId: string | null): TxBody<WatchRefusal | null> {
  if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('watch_activate:' || ?, 0)) AS x", [userId])
  const others = yield* t.all<{ id: string; query: string }>('SELECT id, query FROM watches WHERE user_id = ? AND active = 1', [userId])
  const live = others.filter(w => w.id !== exceptId)
  if (live.length >= MAX_WATCHES) return { error: LIMIT_MSG, code: 'watch_limit' }
  if (live.some(w => w.query === query)) return { error: DUPE_MSG, code: 'watch_duplicate' }
  return null
}

export async function createWatch(db: Db, userId: string, query: string, icp: string, runBudget: string | null = null, now = nowS()): Promise<{ watch?: Watch; error?: string; code?: WatchRefusal['code'] }> {
  const stored = query.slice(0, 600)
  const id = randomBytes(12).toString('hex')
  const refused = await db.tx(function* (t) {
    const no = yield* activationCheck(t, userId, stored, null)
    if (no) return no
    yield* t.run('INSERT INTO watches (id, user_id, query, icp, next_run_at, run_budget) VALUES (?, ?, ?, ?, ?, ?)', [id, userId, stored, icp, now + WEEK_S, runBudget])
    return null
  })
  if (refused) return refused
  return { watch: await db.get<Watch>('SELECT * FROM watches WHERE id = ? AND user_id = ?', [id, userId]) }
}

export async function listWatches(db: Db, userId: string, now = nowS()) {
  // created_at is whole seconds: id breaks ties so watches made in the same second always list in the same order
  const rows = await db.all<Watch>('SELECT * FROM watches WHERE user_id = ? ORDER BY created_at DESC, id DESC', [userId])
  return Promise.all(rows.map(async w => {
    // the watch's own jobs only (scan_jobs.user_id), newest first; same-second ties in insertion order
    const last = await db.get<{ id: string; status: string; finished_at: number | null }>('SELECT id, status, finished_at FROM scan_jobs WHERE watch_id = ? AND user_id = ? ORDER BY created_at DESC, insert_seq DESC LIMIT 1', [w.id, userId])
    const newCount = last ? Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM leads WHERE scan_job_id = ? AND watch_new = 1', [last.id]))!.n) : 0
    // #1042: the automatic repeat of the account's first play (lib/play-repeat.ts: its only job older than the watch)
    const auto = !!(await db.get('SELECT 1 AS x FROM scan_jobs WHERE watch_id = ? AND user_id = ? AND created_at < ? LIMIT 1', [w.id, userId, w.created_at]))
    // #1042: a run the free plan's daily cap skipped, until the play runs again (lib/play-cadence.ts)
    const skipped = auto && w.active === 1 ? await skipNotice(db, userId, { id: w.id, last_run_at: w.last_run_at == null ? null : Number(w.last_run_at) }, now) : null
    return { id: w.id, query: w.query, icp: JSON.parse(w.icp) as unknown, active: w.active === 1, next_run_at: w.next_run_at, last_run_at: w.last_run_at, paused_reason: w.paused_reason, last_job_id: last?.id ?? null, last_status: last?.status ?? null, new_leads: newCount, auto, interval_s: watchIntervalS(auto), skipped }
  }))
}

// true when done, false when the watch is not this tenant's, or a refusal when resuming would break the active cap or
// duplicate an active query. A refused resume leaves the watch paused with its reason and schedule untouched; resuming
// an already-active watch is a no-op that keeps its next_run_at.
export async function watchAction(db: Db, userId: string, id: string, action: 'pause' | 'resume' | 'delete', now = nowS()): Promise<boolean | WatchRefusal> {
  if (action === 'delete') return (await db.run('DELETE FROM watches WHERE id = ? AND user_id = ?', [id, userId])).changes === 1
  if (action === 'pause') return (await db.run('UPDATE watches SET active = 0 WHERE id = ? AND user_id = ?', [id, userId])).changes === 1
  return db.tx(function* (t): TxBody<boolean | WatchRefusal> {
    // lock first, then read the watch, so a concurrent resume of the same or a sibling watch is seen
    if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('watch_activate:' || ?, 0)) AS x", [userId])
    const w = yield* t.get<{ query: string; active: number }>('SELECT query, active FROM watches WHERE id = ? AND user_id = ?', [id, userId])
    if (!w) return false
    if (w.active === 1) return true
    const no = yield* activationCheck(t, userId, w.query, id)
    if (no) return no
    // the next run is one of the play's own intervals away: a day for the first play's repeat, a week otherwise
    const every = watchIntervalS(yield* isFirstPlayRepeatStep(t, userId, id))
    return (yield* t.run('UPDATE watches SET active = 1, paused_reason = NULL, next_run_at = ? WHERE id = ? AND user_id = ? AND active = 0', [now + every, id, userId])).changes === 1
  })
}

// The domain (or normalized company name) is the identity a watch remembers.
export function seenKey(company: string, domain: string | null): string {
  if (domain) return domain.toLowerCase()
  return company.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// After a watch run finishes: flag leads this watch has never surfaced, and remember them. Sync on the raw handle (the
// runner today); writeWatchLeads is the same on the Db layer, in one transaction. A lead is new when its key was not
// seen before this run, so two leads of one company in one run are both new, in either version.
const WATCH_LEADS_SQL = 'SELECT id, company, company_domain FROM leads WHERE scan_job_id = ?'
const WATCH_SEEN_SQL = 'SELECT seen_key FROM watch_seen WHERE watch_id = ?'
const MARK_NEW_SQL = 'UPDATE leads SET watch_new = 1 WHERE id = ?'
// only the primary key can conflict here (the watch id is the caller's, from a live watch), as with INSERT OR IGNORE
const REMEMBER_SQL = 'INSERT INTO watch_seen (watch_id, seen_key) VALUES (?, ?) ON CONFLICT (watch_id, seen_key) DO NOTHING'
type WatchLead = { id: string; company: string; company_domain: string | null }
const freshLeads = (leads: WatchLead[], seen: Set<string>) => leads.map(l => ({ id: l.id, key: seenKey(l.company, l.company_domain) })).map(x => ({ ...x, fresh: !!x.key && !seen.has(x.key) }))
export function markWatchLeads(db: Database.Database, watchId: string, jobId: string): number {
  const leads = db.prepare(WATCH_LEADS_SQL).all(jobId) as WatchLead[]
  const seen = new Set((db.prepare(WATCH_SEEN_SQL).all(watchId) as { seen_key: string }[]).map(r => r.seen_key))
  let fresh = 0
  const mark = db.prepare(MARK_NEW_SQL)
  const remember = db.prepare(REMEMBER_SQL)
  for (const l of freshLeads(leads, seen)) {
    if (l.fresh) { mark.run(l.id); fresh++ }
    remember.run(watchId, l.key)
  }
  return fresh
}
// writeWatchLeads as a transaction step (#1042: the first play's repeat remembers that play's own leads in the
// transaction that creates the repeat).
export function* watchLeadsStep(t: Tx, watchId: string, jobId: string): TxBody<number> {
  const leads = yield* t.all<WatchLead>(WATCH_LEADS_SQL, [jobId])
  const seen = new Set((yield* t.all<{ seen_key: string }>(WATCH_SEEN_SQL, [watchId])).map(r => r.seen_key))
  let fresh = 0
  for (const l of freshLeads(leads, seen)) {
    if (l.fresh) { yield* t.run(MARK_NEW_SQL, [l.id]); fresh++ }
    yield* t.run(REMEMBER_SQL, [watchId, l.key])
  }
  return fresh
}
export function writeWatchLeads(db: Db, watchId: string, jobId: string): Promise<number> {
  return db.tx(t => watchLeadsStep(t, watchId, jobId))
}

// A step a scheduled run takes first in each of its transactions (the tick's lease fence, lib/shared/lease.ts), so a
// run that lost its lease writes nothing. Without one, the writes are not fenced.
export type Fence = (t: Tx) => TxBody<void>
const noFence: Fence = function* () { /* not fenced */ }

// Due watches -> one scan job each, funded by the user's own key. Never trial-funded, with ONE exception (#1042, owner
// scope 2026-11-11): the repeat dazl creates for a new account's first play may run on the free trial while the existing
// trial caps admit it (lib/play-funding.ts). Otherwise no key, or no quota, pauses the watch with the reason; it never
// falls back to the trial key. A trial the caps refuse pauses it too ('trial_used' once the account's free searches are
// spent), except the global daily ceiling, which leaves it due for a later tick.
// Each watch's writes are one transaction, and only while the watch is still the due one this run read (not paused,
// deleted or already run in between): the job and the watch's next run commit together, or neither does. The account's
// active scans are re-checked inside that transaction under the shared admission lock (lib/play-funding.ts), so a
// "Find leads now" click and this tick never both queue a scan for the account.
//
// #1042 (lib/play-cadence.ts): the first play's repeat runs again a day later (any other watch a week later). On the free
// plan it starts only while the account has started no scan this UTC day; otherwise that day's run is skipped (moved to
// the same time tomorrow, with an audit event Home and Plays read), and each run it does start carries max_usd $0.30.
// The cap is checked before any trial reservation and again inside the job's transaction, under the admission lock.
export async function runDueWatches(db: Db, o: { now?: number; fence?: Fence; env?: Record<string, string | undefined> } = {}): Promise<{ ran: number; paused: number; skipped: number }> {
  const now = o.now ?? nowS(), fence = o.fence ?? noFence
  const due = await db.all<Watch>('SELECT * FROM watches WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at, id', [now])
  let ran = 0, paused = 0, skipped = 0
  for (const w of due) {
    const pause = async (reason: string) => {
      const r = await db.tx(function* (t) { yield* fence(t); return yield* t.run('UPDATE watches SET active = 0, paused_reason = ? WHERE id = ? AND active = 1 AND next_run_at = ?', [reason, w.id, w.next_run_at]) })
      if (r.changes === 1) paused++
    }
    const keyed = await readHasKey(db, w.user_id)
    const funder = keyed ? null : await trialFunder(db, w.user_id, w.id, o.env)
    if (!keyed && !funder) { await pause('no_api_key'); continue }
    if (!(await readScanQuota(db, w.user_id)).allowed) { await pause('quota_exceeded'); continue }
    const auto = await isFirstPlayRepeat(db, w.user_id, w.id)
    const capped = await freeCapApplies(db, w.user_id, auto)
    // the free plan's daily cap, before anything is reserved: today's run is skipped, not retried every tick
    const capHit = function* (t: Tx): TxBody<boolean> { return capped && (yield* scansTodayStep(t, w.user_id, now)) >= FREE_DAILY_RUNS }
    if (capped) {
      const out = await db.tx(function* (t) {
        yield* fence(t)
        yield* lockScanAdmission(t, w.user_id)
        if (!(yield* capHit(t))) return 'run' as const
        return (yield* skipWatchRunStep(t, w, now)) ? 'skipped' as const : 'gone' as const
      })
      if (out === 'skipped') skipped++
      if (out !== 'run') continue
    }
    if (await countActiveJobs(db, w.user_id) > 0) continue // a scan is already going; the next tick picks this watch up
    // the free trial's existing admission, only for the first play's repeat with no key (nothing reserved otherwise)
    let trial: TrialRun | null = null
    if (funder) {
      const a = await admitTrialRun(db, funder, now, o.env)
      if (!a.ok) { const why = trialPauseReason(a.reason); if (why) await pause(why); continue }
      trial = a.run
    }
    // the offer already confirmed for this play's request (#349), with the snapshot it was confirmed beside
    const play = await scheduledPlayOffer(db, w.user_id, w.query)
    let job: string | null = null
    try {
      const out = await db.tx(function* (t): TxBody<string | 'skipped' | null> {
        yield* fence(t)
        yield* lockScanAdmission(t, w.user_id)
        if ((yield* countActiveJobsStep(t, w.user_id)) > 0) return null
        if (yield* capHit(t)) return (yield* skipWatchRunStep(t, w, now)) ? 'skipped' : null // a scan started since the check above
        const r = yield* t.run('UPDATE watches SET last_run_at = ?, next_run_at = ? WHERE id = ? AND active = 1 AND next_run_at = ?', [now, now + watchIntervalS(auto), w.id, w.next_run_at])
        if (r.changes !== 1) return null
        const runBudget = capped ? cappedRunBudget(w.run_budget) : w.run_budget ?? null
        const id = yield* queryJobStep(t, w.user_id, { id: trial?.jobId, query: w.query, icp: w.icp, watchId: w.id, runBudget, ...(play ? { offer: play.offer, seller: play.seller ?? undefined } : {}) }, now)
        if (trial) yield* markTrialJobStep(t, w.user_id, id)
        return id
      })
      if (out === 'skipped') skipped++
      else job = out
    } finally { if (trial && !job) await releaseTrialRun(db, w.user_id, trial) } // refused or threw: the attempt goes back
    if (job) ran++
  }
  return { ran, paused, skipped }
}
