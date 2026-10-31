// Watch scans: a saved query + ICP re-run weekly. Design approved by the repo owner on 2026-10-21:
// - every run counts against the monthly scan quota
// - never trial-funded: a watch with no user key pauses, it never touches the operator key
// - max 3 active watches per user
// - "new" = the lead's company domain (or normalized name) was not seen by this watch before
// - results surface in-app only
// On the Db layer (SQLite or Postgres), except markWatchLeads: the scan runner still calls it on the raw handle.
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'
import { randomBytes } from 'node:crypto'
import { countActiveJobs, queryJobStep } from './scan/store-db.ts'
import { readHasKey } from './llm/key-store.ts'
import { readScanQuota } from './plans.ts'

export const MAX_WATCHES = 3
const WEEK_S = 7 * 86400

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

class LinkRace extends Error {}

// Key-sorted stable JSON so two normalized buyer profiles compare by content, not key order.
function canonical(json: string | null): string {
  if (!json) return ''
  try {
    const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, sort(x)]))
      : v
    return JSON.stringify(sort(JSON.parse(json)))
  } catch { return '' }
}

export async function createWatch(db: Db, userId: string, query: string, icp: string, runBudget: string | null = null, now = nowS(), originJobId?: string): Promise<{ watch?: Watch; error?: string }> {
  const active = Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM watches WHERE user_id = ? AND active = 1', [userId]))!.n)
  if (active >= MAX_WATCHES) return { error: `You already have ${MAX_WATCHES} weekly watches. Pause or delete one first.` }
  const dupe = await db.get('SELECT id FROM watches WHERE user_id = ? AND active = 1 AND query = ?', [userId, query])
  if (dupe) return { error: 'You are already watching that search.' }
  const id = randomBytes(12).toString('hex')
  // Saving "watch this weekly" from a finished search links that search as the play's first run: the history a
  // user just looked at is where the play begins, without an extra scan. The play must be the same search it
  // continues: the query AND the canonical buyer profile it ran with. Its leads are remembered in watch_seen so
  // scheduled runs dedupe against them, but they are not relabelled: watch_new stays a scheduled-run flag, the
  // origin run predates the play, and its row keeps the meaning it had when the user first saw it (scores,
  // evidence and source_kind are never touched).
  if (originJobId) {
    let linked: Watch | { error: string }
    try {
      linked = await db.tx(function* (t: Tx): TxBody<Watch | { error: string }> {
        const job = yield* t.get<{ id: string; status: string; query: string | null; icp: string | null; watch_id: string | null; finished_at: number | null; created_at: number }>('SELECT id, status, query, icp, watch_id, finished_at, created_at FROM scan_jobs WHERE id = ? AND user_id = ?', [originJobId, userId])
        if (!job) return { error: 'That search could not be found.' }
        if (job.watch_id) return { error: 'That search already belongs to a play.' }
        if (job.status !== 'done') return { error: 'Only a finished search can start a play.' }
        if ((job.query ?? '').trim() !== query) return { error: 'The search changed since it ran - run it again, then save the play.' }
        if (canonical(job.icp) !== canonical(icp)) return { error: 'The buyer profile changed since it ran - run it again, then save the play.' }
        yield* t.run('INSERT INTO watches (id, user_id, query, icp, next_run_at, last_run_at, run_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, userId, query.slice(0, 600), icp, now + WEEK_S, job.finished_at ?? job.created_at, runBudget, now])
        const r = yield* t.run('UPDATE scan_jobs SET watch_id = ? WHERE id = ? AND user_id = ? AND watch_id IS NULL', [id, originJobId, userId])
        if (r.changes !== 1) throw new LinkRace()
        const leads = yield* t.all<WatchLead>(WATCH_LEADS_SQL, [originJobId])
        for (const l of freshLeads(leads, new Set())) yield* t.run(REMEMBER_SQL, [id, l.key])
        return (yield* t.get<Watch>('SELECT * FROM watches WHERE id = ? AND user_id = ?', [id, userId]))!
      })
    } catch (e) {
      // A concurrent save linked the same search between read and guarded update: a controlled conflict, not a crash.
      if (e instanceof LinkRace) return { error: 'That search already belongs to a play.' }
      throw e
    }
    if ('error' in linked) return { error: linked.error }
    return { watch: linked }
  }
  await db.run('INSERT INTO watches (id, user_id, query, icp, next_run_at, run_budget, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, userId, query.slice(0, 600), icp, now + WEEK_S, runBudget, now])
  return { watch: await db.get<Watch>('SELECT * FROM watches WHERE id = ? AND user_id = ?', [id, userId]) }
}

export async function listWatches(db: Db, userId: string) {
  // created_at is whole seconds: id breaks ties so watches made in the same second always list in the same order
  const rows = await db.all<Watch>('SELECT * FROM watches WHERE user_id = ? ORDER BY created_at DESC, id DESC', [userId])
  return Promise.all(rows.map(async w => {
    // the watch's own jobs only (scan_jobs.user_id), newest first; same-second ties in insertion order
    const last = await db.get<{ id: string; status: string; finished_at: number | null }>('SELECT id, status, finished_at FROM scan_jobs WHERE watch_id = ? AND user_id = ? ORDER BY created_at DESC, insert_seq DESC LIMIT 1', [w.id, userId])
    const newCount = last ? Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM leads WHERE scan_job_id = ? AND watch_new = 1', [last.id]))!.n) : 0
    return { id: w.id, query: w.query, icp: JSON.parse(w.icp) as unknown, active: w.active === 1, next_run_at: w.next_run_at, last_run_at: w.last_run_at, paused_reason: w.paused_reason, last_job_id: last?.id ?? null, last_status: last?.status ?? null, new_leads: newCount }
  }))
}

export async function watchAction(db: Db, userId: string, id: string, action: 'pause' | 'resume' | 'delete', now = nowS()): Promise<boolean> {
  if (action === 'delete') return (await db.run('DELETE FROM watches WHERE id = ? AND user_id = ?', [id, userId])).changes === 1
  if (action === 'pause') return (await db.run('UPDATE watches SET active = 0 WHERE id = ? AND user_id = ?', [id, userId])).changes === 1
  return (await db.run('UPDATE watches SET active = 1, paused_reason = NULL, next_run_at = ? WHERE id = ? AND user_id = ?', [now + WEEK_S, id, userId])).changes === 1
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
export function writeWatchLeads(db: Db, watchId: string, jobId: string): Promise<number> {
  return db.tx(function* (t: Tx): TxBody<number> {
    const leads = yield* t.all<WatchLead>(WATCH_LEADS_SQL, [jobId])
    const seen = new Set((yield* t.all<{ seen_key: string }>(WATCH_SEEN_SQL, [watchId])).map(r => r.seen_key))
    let fresh = 0
    for (const l of freshLeads(leads, seen)) {
      if (l.fresh) { yield* t.run(MARK_NEW_SQL, [l.id]); fresh++ }
      yield* t.run(REMEMBER_SQL, [watchId, l.key])
    }
    return fresh
  })
}

// A step a scheduled run takes first in each of its transactions (the tick's lease fence, lib/shared/lease.ts), so a
// run that lost its lease writes nothing. Without one, the writes are not fenced.
export type Fence = (t: Tx) => TxBody<void>
const noFence: Fence = function* () { /* not fenced */ }

// Due watches -> one scan job each, funded by the user's own key only. Never trial-funded:
// no key or no quota pauses the watch with the reason, it does not fall back to the trial key.
// Each watch's writes are one transaction, and only while the watch is still the due one this run read (not paused,
// deleted or already run in between): the job and the watch's next run commit together, or neither does.
export async function runDueWatches(db: Db, o: { now?: number; fence?: Fence } = {}): Promise<{ ran: number; paused: number }> {
  const now = o.now ?? nowS(), fence = o.fence ?? noFence
  const due = await db.all<Watch>('SELECT * FROM watches WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at, id', [now])
  let ran = 0, paused = 0
  for (const w of due) {
    const pause = async (reason: string) => {
      const r = await db.tx(function* (t) { yield* fence(t); return yield* t.run('UPDATE watches SET active = 0, paused_reason = ? WHERE id = ? AND active = 1 AND next_run_at = ?', [reason, w.id, w.next_run_at]) })
      if (r.changes === 1) paused++
    }
    if (!(await readHasKey(db, w.user_id))) { await pause('no_api_key'); continue }
    if (!(await readScanQuota(db, w.user_id)).allowed) { await pause('quota_exceeded'); continue }
    if (await countActiveJobs(db, w.user_id) > 0) continue // a scan is already going; the next tick picks this watch up
    const job = await db.tx(function* (t) {
      yield* fence(t)
      const r = yield* t.run('UPDATE watches SET last_run_at = ?, next_run_at = ? WHERE id = ? AND active = 1 AND next_run_at = ?', [now, now + WEEK_S, w.id, w.next_run_at])
      return r.changes === 1 ? yield* queryJobStep(t, w.user_id, { query: w.query, icp: w.icp, watchId: w.id, runBudget: w.run_budget ?? null }, now) : null
    })
    if (job) ran++
  }
  return { ran, paused }
}
