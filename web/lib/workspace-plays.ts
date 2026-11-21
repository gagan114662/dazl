import type { Db } from './db/client.ts'
import { listWatches } from './watch.ts'
import { listMonitors } from './monitors.ts'
import type { MonitorRow } from './saved-plays.ts'
import { historyJobs } from './scan/history-jobs.ts'

// #1471: the ONE list of a workspace's plays, read by both Home ("Your plays", GET /api/plays) and the Plays page. Before
// it, Home listed the account's own searches (GET /api/scan/jobs) and Plays listed only repeating ones (GET /api/watch,
// GET /api/monitors), so a search that ran once was a play on Home and "No saved plays yet" on Plays.
//
// A play is: each weekly watch, each scheduled monitor, and each sentence the account searched that neither repeats
// ("ran once"). Every own search (a query, not a CSV import, not a test fixture: the same rule Home always used) in the
// history window (the newest searches lib/scan/history-jobs.ts lists) belongs to exactly one play, in this order: the
// watch that ran it (scan_jobs.watch_id), the monitor that ran it (monitor_runs), a watch or monitor with the same
// sentence (a hand re-run of a repeating play is that play, as Home's play card already matches it), else the one-off
// play for that sentence. Tenant-scoped through each list's own user_id filter. Read-only.
export type WorkspacePlayKind = 'watch' | 'monitor' | 'once'
export interface WorkspacePlay {
  key: string                 // stable identity across both pages: `${kind}-${id}`
  kind: WorkspacePlayKind
  id: string                  // the watch or monitor id; for a one-off play, its newest search's job id
  query: string
  runs: string[]              // the play's searches in the history window, newest first (job ids)
  last_job_id: string | null  // its newest search, inside the window or (repeating plays) older
  last_run_at: number | null  // when it last ran (unix seconds); null: not run yet
  last_status: string | null  // a one-off play's newest search status; null for repeating plays (their rows carry it)
}
export interface WorkspacePlays {
  plays: WorkspacePlay[]
  watches: Awaited<ReturnType<typeof listWatches>>
  monitors: MonitorRow[]
}

const sentence = (q: string) => q.trim()
// Postgres may hand back a BIGINT as a string
const at = (t: unknown) => t === null || t === undefined ? null : Number(t)

export async function workspacePlays(db: Db, userId: string): Promise<WorkspacePlays> {
  const watches = await listWatches(db, userId)
  // listMonitors returns untyped rows; MonitorRow is the shape GET /api/monitors already serves the Plays page from them
  const monitors = await listMonitors(db, userId) as unknown as MonitorRow[]
  const jobs = (await historyJobs(db, userId)).filter(j => !!j.query && sentence(j.query) !== '' && !j.csv_domain && !j.test_only)
  const ids = jobs.map(j => j.id)
  const watchOf = new Map<string, string>(), monitorOf = new Map<string, string>()
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ')
    for (const r of await db.all<{ id: string; watch_id: string }>(`SELECT id, watch_id FROM scan_jobs WHERE user_id = ? AND watch_id IS NOT NULL AND id IN (${marks})`, [userId, ...ids])) watchOf.set(r.id, r.watch_id)
    for (const r of await db.all<{ job_id: string; monitor_id: string }>(`SELECT r.job_id, r.monitor_id FROM monitor_runs r JOIN monitors m ON m.id = r.monitor_id AND m.user_id = ? WHERE r.job_id IN (${marks})`, [userId, ...ids])) monitorOf.set(r.job_id, r.monitor_id)
  }

  const plays: WorkspacePlay[] = []
  const byKey = new Map<string, WorkspacePlay>()
  const add = (p: WorkspacePlay) => { plays.push(p); byKey.set(p.key, p) }
  for (const w of watches) add({ key: `watch-${w.id}`, kind: 'watch', id: w.id, query: w.query, runs: [], last_job_id: w.last_job_id ?? null, last_run_at: at(w.last_run_at), last_status: null })
  for (const m of monitors) add({ key: `monitor-${m.id}`, kind: 'monitor', id: m.id, query: m.query, runs: [], last_job_id: m.last_job_id ?? null, last_run_at: at(m.last_run_at), last_status: null })
  const watchBySentence = new Map<string, string>(), monitorBySentence = new Map<string, string>(), onceBySentence = new Map<string, WorkspacePlay>()
  for (const w of watches) if (!watchBySentence.has(sentence(w.query))) watchBySentence.set(sentence(w.query), `watch-${w.id}`)
  for (const m of monitors) if (!monitorBySentence.has(sentence(m.query))) monitorBySentence.set(sentence(m.query), `monitor-${m.id}`)

  // jobs are newest first, so each play's runs are too, and a one-off play is named by its newest search
  for (const j of jobs) {
    const s = sentence(j.query!)
    const w = watchOf.get(j.id), m = monitorOf.get(j.id)
    const owner = (w && byKey.get(`watch-${w}`)) || (m && byKey.get(`monitor-${m}`))
      || byKey.get(watchBySentence.get(s) ?? '') || byKey.get(monitorBySentence.get(s) ?? '') || onceBySentence.get(s)
    if (owner) {
      owner.runs.push(j.id)
      if (owner.kind !== 'once' && !owner.last_job_id) owner.last_job_id = j.id
      continue
    }
    const once: WorkspacePlay = { key: `once-${j.id}`, kind: 'once', id: j.id, query: s, runs: [j.id], last_job_id: j.id, last_run_at: at(j.created_at), last_status: j.status }
    plays.push(once); onceBySentence.set(s, once)
  }
  // newest activity first on both pages: a play's last run, or its newest search in the window if later (a hand re-run
  // of a repeating play); a play that never ran goes last. Ties keep the order above (the list order is stable).
  const madeAt = new Map(jobs.map(j => [j.id, Number(j.created_at)]))
  const activity = (p: WorkspacePlay) => Math.max(p.last_run_at ?? -1, p.runs.length ? madeAt.get(p.runs[0]) ?? -1 : -1)
  plays.sort((x, y) => activity(y) - activity(x))
  return { plays, watches, monitors }
}
