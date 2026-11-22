// #1090: a workspace's work can sit dead for days while the scheduler itself is fresh and every run is 'ok'. These are
// the three ways seen in production, as COUNTS ONLY (no tenant id, address or name: /api/health/scheduler is public):
//   needs_reconnect  mailboxes whose connection needs the user (gmail_accounts.status = 'needs_reconnect'): nothing
//                    is sent or read for that workspace until they reconnect;
//   held_over_24h    workspaces whose autopilot is on, with first touches waiting (autopilot_work), and every one of
//                    them has been waiting for HELD_AFTER_S or longer: autopilot is on and nothing is going out;
//   scans_stuck      scans still 'running' past their deadline. A running scan renews claimed_at at every paid call and
//                    is reaped STALE_RUNNING_S after the last one (lib/scan/store.ts), by a status read or the next
//                    tick: one still running a whole tick later than that means the reaper is not reaching it.
// They never change the endpoint's ok/status (the scheduler check's own alerts stay what they were): the external
// uptime probe (ops/uptime/probe.mjs) reads them and alerts once a day while any is above zero.
import { asDb, type DbLike } from '../db/client.ts'
import { STALE_RUNNING_S } from '../scan/store.ts'

export const HELD_AFTER_S = 24 * 60 * 60
// the tick's period (lib/ops/scheduler-runs.ts TICK_EVERY_S; not imported: that module imports this one)
const TICK_S = 15 * 60
export const SCAN_STUCK_AFTER_S = STALE_RUNNING_S + TICK_S

export interface StallCounts { needs_reconnect: number; held_over_24h: number; scans_stuck: number }

export async function stallCounts(d: DbLike, now = Math.floor(Date.now() / 1000)): Promise<StallCounts> {
  const db = asDb(d)
  const count = async (sql: string, params: number[] = []) => Number((await db.get<{ c: number | string }>(sql, params))?.c ?? 0)
  return {
    needs_reconnect: await count("SELECT count(*) AS c FROM gmail_accounts WHERE status = 'needs_reconnect'"),
    held_over_24h: await count(`SELECT count(*) AS c FROM autopilot_settings s WHERE s.enabled = 1
      AND EXISTS (SELECT 1 FROM autopilot_work w WHERE w.tenant_id = s.tenant_id)
      AND NOT EXISTS (SELECT 1 FROM autopilot_work w WHERE w.tenant_id = s.tenant_id AND w.created_at > ?)`, [now - HELD_AFTER_S]),
    scans_stuck: await count("SELECT count(*) AS c FROM scan_jobs WHERE status = 'running' AND COALESCE(claimed_at, created_at) < ?", [now - SCAN_STUCK_AFTER_S]),
  }
}
