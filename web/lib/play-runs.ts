import type { Db } from './db/client.ts'

// #351: every run of one saved play (a weekly watch or a scheduled monitor), newest first, each with its own results in
// Leads (/app/leads?job_id=). A play's runs are separate scans; this is how the Plays page reaches all of them, not only
// the last. Tenant-scoped on both engines: another account's play reads as not found. Read-only.
export type PlayKind = 'watch' | 'monitor'
export interface PlayRun { job_id: string; at: number; status: string; leads: number; new_leads: number | null }
export const PLAY_RUNS_LIMIT = 20

export async function playRuns(db: Db, userId: string, kind: PlayKind, id: string, limit = PLAY_RUNS_LIMIT): Promise<PlayRun[] | null> {
  const n = Math.max(1, Math.min(PLAY_RUNS_LIMIT, Math.floor(limit)))
  if (kind === 'watch') {
    if (!await db.get('SELECT 1 AS x FROM watches WHERE id = ? AND user_id = ?', [id, userId])) return null
    const rows = await db.all<{ job_id: string; at: number; status: string; leads: number; new_leads: number }>(
      `SELECT j.id AS job_id, j.created_at AS at, j.status,
              (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS leads,
              (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id AND l.watch_new = 1) AS new_leads
       FROM scan_jobs j WHERE j.watch_id = ? AND j.user_id = ? ORDER BY j.created_at DESC, j.insert_seq DESC LIMIT ?`, [id, userId, n])
    return rows.map(r => ({ ...r, leads: Number(r.leads), new_leads: Number(r.new_leads) }))
  }
  if (!await db.get('SELECT 1 AS x FROM monitors WHERE id = ? AND user_id = ?', [id, userId])) return null
  const rows = await db.all<{ job_id: string; at: number; status: string; leads: number; new_leads: number | null }>(
    `SELECT r.job_id, r.ran_at AS at, j.status, (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS leads, r.new_count AS new_leads
     FROM monitor_runs r JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = ?
     WHERE r.monitor_id = ? ORDER BY r.ran_at DESC, r.id DESC LIMIT ?`, [userId, id, n])
  return rows.map(r => ({ ...r, leads: Number(r.leads), new_leads: r.new_leads === null ? null : Number(r.new_leads) }))
}
