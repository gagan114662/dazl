import type { Db } from './db/client.ts'

// #351: the runs of one saved play (a weekly watch or a scheduled monitor), newest first, each with its own results in
// Leads (/app/leads?job_id=). A play's runs are separate scans; this is how the Plays page reaches them, not only the
// last: the latest PLAY_RUNS_LIMIT, and whether older ones exist. Tenant-scoped on both engines: another account's play reads as not found. Read-only.
export type PlayKind = 'watch' | 'monitor'
// new_leads: leads first seen in that run, once the run has finished (null while it runs, or when it was not counted)
export interface PlayRun { job_id: string; at: number; status: string; leads: number; new_leads: number | null }
// The newest PLAY_RUNS_LIMIT runs; `more` says older runs exist beyond them, so the page can say the list is not all.
export const PLAY_RUNS_LIMIT = 20
export interface PlayRuns { runs: PlayRun[]; more: boolean }

export async function playRuns(db: Db, userId: string, kind: PlayKind, id: string): Promise<PlayRuns | null> {
  const page = (rows: PlayRun[]): PlayRuns => ({ runs: rows.slice(0, PLAY_RUNS_LIMIT), more: rows.length > PLAY_RUNS_LIMIT })
  if (kind === 'watch') {
    if (!await db.get('SELECT 1 AS x FROM watches WHERE id = ? AND user_id = ?', [id, userId])) return null
    const rows = await db.all<{ job_id: string; at: number; status: string; leads: number; new_leads: number }>(
      `SELECT j.id AS job_id, j.created_at AS at, j.status,
              (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS leads,
              (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id AND l.watch_new = 1) AS new_leads
       FROM scan_jobs j WHERE j.watch_id = ? AND j.user_id = ? ORDER BY j.created_at DESC, j.insert_seq DESC LIMIT ?`, [id, userId, PLAY_RUNS_LIMIT + 1])
    // watch_new is marked when a run finishes (lib/watch.ts), so an unfinished run has no "new" count yet
    return page(rows.map(r => ({ ...r, leads: Number(r.leads), new_leads: r.status === 'done' ? Number(r.new_leads) : null })))
  }
  if (!await db.get('SELECT 1 AS x FROM monitors WHERE id = ? AND user_id = ?', [id, userId])) return null
  const rows = await db.all<{ job_id: string; at: number; status: string; leads: number; new_leads: number | null }>(
    `SELECT r.job_id, r.ran_at AS at, j.status, (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS leads, r.new_count AS new_leads
     FROM monitor_runs r JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = ?
     WHERE r.monitor_id = ? ORDER BY r.ran_at DESC, r.id DESC LIMIT ?`, [userId, id, PLAY_RUNS_LIMIT + 1])
  return page(rows.map(r => ({ ...r, leads: Number(r.leads), new_leads: r.new_leads === null ? null : Number(r.new_leads) })))
}
